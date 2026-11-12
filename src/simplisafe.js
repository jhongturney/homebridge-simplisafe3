import safeLogger from './lib/safeLogger';
import { requestFailureMessage } from './lib/requestDiagnostics';
import axios from 'axios';
import axiosRetry from 'axios-retry';
import WebSocket from 'ws';
import EventEmitter from 'events';
import { AUTH_EVENTS } from './lib/authManager';
import RequestCache from './lib/requestCache';
import withRequestTimeout from './lib/httpRequest';

export const VALID_ALARM_STATES = [
    'off',
    'home',
    'away'
];

export const VALD_LOCK_STATES = [
    'lock',
    'unlock'
];

export const SENSOR_TYPES = {
    'APP': 0,
    'KEYPAD': 1,
    'KEYCHAIN': 2,
    'PANIC_BUTTON': 3,
    'MOTION_SENSOR': 4,
    'ENTRY_SENSOR': 5,
    'GLASSBREAK_SENSOR': 6,
    'CO_SENSOR': 7,
    'SMOKE_SENSOR': 8,
    'WATER_SENSOR': 9,
    'FREEZE_SENSOR': 10,
    'SIREN': 11,
    'SIREN_2': 13,
    'DOORLOCK': 16,
    'DOORLOCK_2': 253
};

export const EVENT_TYPES = {
    ALARM_TRIGGER: 'ALARM_TRIGGER',
    ALARM_OFF: 'ALARM_OFF',
    ALARM_DISARM: 'ALARM_DISARM',
    ALARM_CANCEL: 'ALARM_CANCEL',
    HOME_EXIT_DELAY: 'HOME_EXIT_DELAY',
    HOME_ARM: 'HOME_ARM',
    AWAY_EXIT_DELAY: 'AWAY_EXIT_DELAY',
    AWAY_ARM: 'AWAY_ARM',
    MOTION: 'MOTION',
    ENTRY: 'ENTRY',
    CAMERA_MOTION: 'CAMERA_MOTION',
    DOORBELL: 'DOORBELL',
    DOORLOCK_LOCKED: 'DOORLOCK_LOCKED',
    DOORLOCK_UNLOCKED: 'DOORLOCK_UNLOCKED',
    DOORLOCK_ERROR: 'DOORLOCK_ERROR',
    POWER_OUTAGE: 'POWER_OUTAGE',
    POWER_RESTORED: 'POWER_RESTORED',
    USER_INITIATED_TEST: 'USER_INITIATED_TEST',
};

export class RateLimitError extends Error {
    constructor(...params) {
        super(...params);
        // Maintains proper stack trace for where our error was thrown (only available on V8)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, RateLimitError);
        }
        this.name = 'RateLimitError';
    }
}

const subscriptionCacheTime = 3000; // ms
const sensorCacheTime = 3000; // ms
const rateLimitInitialInterval = 60000; // ms
const rateLimitMaxInterval = 2 * 60 * 60 * 1000; // ms
const sensorRefreshLockoutDuration = 20000; // ms
const errorSuppressionDuration = 5 * 60 * 1000; // ms
const alarmRefreshInterval = 62000; // ms

const wsUrl = 'wss://socketlink.prd.aser.simplisafe.com';
const socketRetryInterval = 1000; //ms
const socketHeartbeatInterval = 60 * 1000; //ms

const ssApi = axios.create({
    baseURL: 'https://api.simplisafe.com/v1'
});
axiosRetry(ssApi, {
    retries: 2,
    // Preserve the v3 policy: do not automatically repeat rate-limited requests.
    retryCondition: error => error.response?.status !== 429 && axiosRetry.isNetworkOrIdempotentRequestError(error)
});

const pluginUserAgent = 'homebridge-simplisafe3';
const appHubApi = axios.create({
    baseURL: 'https://app-hub.prd.aser.simplisafe.com',
    headers: {
        'User-Agent': pluginUserAgent,
        'Accept': 'application/json, text/plain, */*'
    }
});

class SimpliSafe3 extends EventEmitter {

    lifecycle = new AbortController();
    authManager;
    userId;
    subId;
    accountNumber;
    socket;
    readCache = new RequestCache();
    pendingPolls = new Set();
    pollInFlight = false;
    pollCooldownTimeoutID;
    alarmRefreshIntervalID;
    alarmSubscriptions = [];
    sensorRefreshIntervalID;
    sensorRefreshTime;
    refreshLockoutTimeoutID;
    refreshLockoutEnabled = false;
    sensorSubscriptions = [];
    errorSupperessionTimeoutID;
    nSuppressedErrors;
    storagePath;
    nSocketConnectFailures = 0;
    socketHeartbeatIntervalID;
    socketIsAlive;
    isAwaitingSocketReconnect;
    isBlocked;
    nextBlockInterval = rateLimitInitialInterval;
    nextAttempt = 0;

    constructor(sensorRefreshTime = 15000, authManager, storagePath, log, debug) {
        super();
        this.sensorRefreshTime = sensorRefreshTime;
        this.log = safeLogger(log || console.log);
        this.debug = debug;
        this.storagePath = storagePath;
        this.authManager = authManager;
        this.authFailureListener = () => {
            if (this.socket) this.handleSocketConnectionFailure();
        };
        this.authManager.on(AUTH_EVENTS.REFRESH_CREDENTIALS_FAILURE, this.authFailureListener);
        
        this.resetRateLimitHandler();
    }

    resetRateLimitHandler() {
        this.isBlocked = false;
        this.nextBlockInterval = rateLimitInitialInterval;
    }

    setRateLimitHandler() {
        this.isBlocked = true;
        this.nextAttempt = Date.now() + this.nextBlockInterval;
        if (this.nextBlockInterval < rateLimitMaxInterval) {
            this.nextBlockInterval = this.nextBlockInterval * 2;
        }
    }

    async request(params) {
        this.lifecycle.signal.throwIfAborted();
        if (params.signal?.aborted) throw params.signal.reason || new Error('SimpliSafe request cancelled');
        if (this.isBlocked && Date.now() < this.nextAttempt) {
            let err = new RateLimitError('Blocking request: rate limited');
            throw err;
        }

        if (!this.authManager.isAuthenticated()) {
            try {
                await this.authManager.refreshCredentials();
                if (this.debug) this.log('Credentials refreshed successfully after failed request');
            } catch (credentialsErr) {
                if (this.debug) this.log.error('Recovery credentials refresh failed with error:', credentialsErr);
                if (credentialsErr.isAxiosError && credentialsErr.response) {
                    throw new Error(`${credentialsErr.response.status}: ${credentialsErr.response.statusText}`);
                } else {
                    throw credentialsErr;
                }
            }
        }

        const requestStarted = performance.now();
        try {
            const response = await withRequestTimeout(options => ssApi.request({
                ...options,
                ...params,
                signal: options.signal,
                headers: {
                    ...params.headers,
                    Authorization: `${this.authManager.tokenType} ${this.authManager.accessToken}`
                }
            }), params.signal ? AbortSignal.any([params.signal, this.lifecycle.signal]) : this.lifecycle.signal);
            this.resetRateLimitHandler();
            return response.data;
        } catch (err) {
            if (params.signal?.aborted || this.lifecycle.signal.aborted) throw err;
            if (!err.response) {
                let rateLimitError = new RateLimitError(err);
                this.setRateLimitHandler();
                this.log.error(requestFailureMessage(params, err, Math.max(0, Math.ceil((this.nextAttempt - Date.now()) / 1000)), performance.now() - requestStarted));
                throw rateLimitError;
            }

            let statusCode = err.response.status;
            if (statusCode == 403) {
                this.setRateLimitHandler();
                this.log.error(requestFailureMessage(params, err, Math.max(0, Math.ceil((this.nextAttempt - Date.now()) / 1000)), performance.now() - requestStarted));
                throw new RateLimitError(err.response.data);
            } else {
                throw err.response.data;
            }
        }
    }

    cachedGet(url, forceRefresh = false, ttl = 0) {
        return this.readCache.get(url, () => this.request({ method: 'GET', url }), { refresh: forceRefresh, ttl });
    }

    async getUserId() {
        if (this.userId) {
            return this.userId;
        }

        let data = await this.cachedGet('/api/authCheck');
        this.userId = data.userId;
        return this.userId;
    }

    async getSubscriptions() {
        let userId = await this.getUserId();
        let data = await this.cachedGet(`/users/${userId}/subscriptions?activeOnly=false`);

        // sStatus 7: Unmonitored & self-monitoring
        // sStatus 10: Standard
        // sStatus 20: Interactive
        let subscriptions = data.subscriptions.filter(s => [7, 10, 20].includes(s.sStatus));

        if (this.accountNumber) {
            subscriptions = subscriptions.filter(s => s.location.account === this.accountNumber);
        }

        // Free trials can have same accountNumber but only one should be "activated"
        if (subscriptions.length > 1) subscriptions = subscriptions.filter(s => s.activated > 0);

        if (subscriptions.length == 1) {
            this.subId = subscriptions[0].sid;
        }

        return subscriptions;
    }

    async getSubscription(forceRefresh = false) {
        let subscriptionId = this.subId;

        if (!subscriptionId) {
            let subs = await this.getSubscriptions();
            if (subs.length == 1) {
                subscriptionId = subs[0].sid;
            } else if (subs.length == 0) {
                throw new Error('No matching monitoring plans found. Check your account and ensure you have an active plan.');
            } else {
                let accountNumbers = subs.map(s => s.location.account);
                throw new Error(`Multiple accounts found. You must specify an account number in the plugin settings. See README https://github.com/homebridge-simplisafe3/homebridge-simplisafe3#subscriptionid-account-number for more info. The account numbers found were: ${accountNumbers.join(', ')}.`);
            }
        }

        let data = await this.cachedGet(`/subscriptions/${subscriptionId}/`, forceRefresh, subscriptionCacheTime);
        return data.subscription;
    }

    setDefaultSubscription(accountNumber) {
        if (!accountNumber) {
            throw new Error('Account Number not defined');
        }

        this.accountNumber = accountNumber;
    }

    async getAlarmSystem(forceRefresh = false) {
        let subscription = await this.getSubscription(forceRefresh);

        if (subscription.location && subscription.location.system) {
            return subscription.location.system;
        } else {
            throw new Error('Subscription format not understood:', subscription);
        }
    }

    async setAlarmState(newState) {
        let state = newState.toLowerCase();

        if (VALID_ALARM_STATES.indexOf(state) == -1) {
            throw new Error('Invalid target state');
        }

        if (!this.subId) {
            await this.getSubscription();
        }

        let data = await this.request({
            method: 'POST',
            url: `/ss3/subscriptions/${this.subId}/state/${state}`
        });

        this.readCache.clear();
        this.handleSensorRefreshLockout();
        
        return data;
    }

    async getSensors(forceUpdate = false, forceRefresh = false) {
        if (!this.subId) {
            await this.getSubscription();
        }

        let data = await this.cachedGet(`/ss3/subscriptions/${this.subId}/sensors?forceUpdate=${forceUpdate ? 'true' : 'false'}`, forceRefresh, sensorCacheTime);
        return data.sensors;
    }

    async getCameras(forceRefresh = false) {
        let system = await this.getAlarmSystem(forceRefresh);

        if (system.cameras) {
            return system.cameras;
        } else {
            throw new Error('Error getting alarm system');
        }
    }

    // Idle cameras stop publishing, so the SimpliSafe apps wake them before every stream
    async wakeCameras(signal) {
        this.lifecycle.signal.throwIfAborted();
        signal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
        if (!this.subId) {
            await this.getSubscription();
        }

        if (!this.authManager.isAuthenticated()) {
            await this.authManager.refreshCredentials();
        }

        await withRequestTimeout(options => appHubApi.request({
            ...options,
            method: 'POST',
            url: `/v1/ss3/subscriptions/${this.subId}/camera-wakeup`,
            headers: {
                Authorization: `${this.authManager.tokenType} ${this.authManager.accessToken}`,
                'Content-Type': 'application/json'
            },
            data: { wakeAll: true }
        }), signal);
    }

    // Returns LiveKit room details for cameras (internally 'MIST')
    // token is short lived so it must be fetched per stream, not cached
    async getCameraLiveView(cameraUuid, signal) {
        this.lifecycle.signal.throwIfAborted();
        signal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
        if (this.isBlocked && Date.now() < this.nextAttempt) {
            throw new RateLimitError('Blocking request: rate limited');
        }

        if (!this.subId) {
            await this.getSubscription();
        }

        if (!this.authManager.isAuthenticated()) {
            await this.authManager.refreshCredentials();
        }

        try {
            const response = await withRequestTimeout(options => appHubApi.request({
                ...options,
                method: 'GET',
                url: `/v2/cameras/${cameraUuid}/${this.subId}/live-view`,
                headers: {
                    Authorization: `${this.authManager.tokenType} ${this.authManager.accessToken}`
                }
            }), signal);
            this.resetRateLimitHandler();

            const details = response.data && response.data.liveKitDetails;
            if (!details || !details.liveKitURL || !details.userToken) {
                throw new Error(`Unexpected live-view response: ${JSON.stringify(response.data)}`);
            }

            return { ...details, cameraStatus: response.data.cameraStatus };
        } catch (err) {
            if (err.response && err.response.status === 403) {
                this.setRateLimitHandler();
                throw new RateLimitError(err.response.data);
            }
            throw err;
        }
    }

    async getLocks(forceRefresh) {
        if (!this.subId) {
            await this.getSubscription();
        }

        let data = await this.cachedGet(`/doorlock/${this.subId}`, forceRefresh, sensorCacheTime);
        this.refreshLockoutEnabled = data.length > 0;
        return data;

    }

    async setLockState(lockId, newState) {
        let state = newState.toLowerCase();

        if (VALD_LOCK_STATES.indexOf(state) == -1) {
            throw new Error('Invalid target state');
        }

        if (!this.subId) {
            await this.getSubscription();
        }

        let data = await this.request({
            method: 'POST',
            url: `/doorlock/${this.subId}/${lockId}/state`,
            data: {
                state: state
            }
        });
        this.readCache.clear();
        return data;
    }

    async startListening() {
        if (this.lifecycle.signal.aborted || this.socket || this.socketConnecting) return;

        if (!this.authManager.isAuthenticated()) {
            this.log.error('Socket connect ignored: Not authenticated with SimpliSafe');
            this.handleSocketConnectionFailure();
            return;
        }

        let userId;
        this.socketConnecting = true;
        try {
            userId = await this.getUserId();
        } catch (err) {
            this.handleSocketConnectionFailure();
            return;
        } finally {
            this.socketConnecting = false;
        }
        if (this.lifecycle.signal.aborted || this.socket) return;
        this.socket = new WebSocket(wsUrl, {
            handshakeTimeout: 5000
        });

        this.socket.on('open', () => {
            if (this.debug) this.log('SSAPI socket `open`');
            this.socket.send(JSON.stringify({
                'datacontenttype': 'application/json',
                'type': 'com.simplisafe.connection.identify',
                'time': new Date().toISOString(),
                'id': `ts:${Date.now()}`,
                'specversion': '1.0',
                'source': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Safari/605.1.15',
                'data': {
                    'auth': {
                        'schema': 'bearer',
                        'token': this.authManager.accessToken,
                    },
                    'join': [`uid:${userId}`]
                }
            }));
        });

        this.socket.on('close', () => {
            if (this.debug) this.log.error('SSAPI socket `closed`');
            this.log.warn('SimpliSafe real time events disconnected.');
            this.handleSocketConnectionFailure();
        });

        this.socket.on('error', (err) => {
            if (this.debug) this.log.error('SSAPI socket `error`:', err);
            this.log.warn('SimpliSafe real time events disconnected.');
            this.handleSocketConnectionFailure();
        });

        this.socket.on('unexpected-response', (reason) => {
            if (this.debug) this.log('SSAPI socket received unexpected-response:', reason);
            this.handleSocketConnectionFailure();
        });

        this.socket.on('pong', () => {
            if (this.debug) this.log('SSAPI socket `heartbeat`');
            this.socketIsAlive = true;
        });

        this.socket.on('message', (message) => {
            try { message = JSON.parse(message); }
            catch (err) { return; }
            if (!message || typeof message !== 'object') return;

            if (this.debug && !['service', 'messagequeue'].includes(message.source)) this.log('SSAPI socket received message:', message);

            if (message.source == 'service') {
                switch (message.type) {
                case 'com.simplisafe.service.hello':
                    if (this.debug) this.log('SSAPI socket `hello`');
                    break;
                case 'com.simplisafe.service.registered':
                    if (this.debug) this.log('SSAPI socket `registered`');
                    break;
                case 'com.simplisafe.namespace.subscribed':
                    if (this.debug) this.log('SSAPI socket `subscribed`');
                    this.log('SimpliSafe real time events connected.');
                    this.nSocketConnectFailures = 0;
                    this.socketIsAlive = true;
                    
                    // heartbeat
                    clearInterval(this.socketHeartbeatIntervalID);
                    this.socketHeartbeatIntervalID = setInterval(() => {
                        if (!this.socketIsAlive) {
                            if (this.debug) this.log('SSAPI socket heartbeat lost');
                            this.handleSocketConnectionFailure();
                            return;
                        } else {
                            this.socketIsAlive = false;
                            this.socket.ping();
                        }
                    }, socketHeartbeatInterval + (5000 * Math.random()));
                    break;
                default:
                    if (this.debug) this.log('Received unknown service message:', message);
                }
            } else if (message.source == 'messagequeue') {
                let data = message.data;
                if (data.sid != this.subId) {
                    // Ignore event as it doesn't relate to this account
                    return;
                }

                switch (data.eventType) {
                case 'alarm':
                    if (data.eventCid == 1601) {
                        this.emit(EVENT_TYPES.USER_INITIATED_TEST, data);
                    } else {
                        this.emit(EVENT_TYPES.ALARM_TRIGGER, data);
                    }
                    break;
                case 'alarmCancel':
                    this.emit(EVENT_TYPES.ALARM_OFF, data);
                    break;
                case 'cameraStatus':
                    // nothing to do
                    break;
                case 'activity':
                case 'activityQuiet':
                default:
                    // if it's not an alarm event, check by eventCid
                    switch (data.eventCid) {
                    case 1400:
                    case 1407:
                        // 1400 is disarmed with Master PIN, 1407 is disarmed with Remote
                        this.emit(EVENT_TYPES.ALARM_DISARM, data);
                        this.handleSensorRefreshLockout();
                        break;
                    case 1406:
                        this.emit(EVENT_TYPES.ALARM_CANCEL, data);
                        this.handleSensorRefreshLockout();
                        break;
                    case 1409:
                        this.emit(EVENT_TYPES.MOTION, data);
                        break;
                    case 9441:
                        this.emit(EVENT_TYPES.HOME_EXIT_DELAY, data);
                        break;
                    case 3441:
                    case 3491:
                        this.emit(EVENT_TYPES.HOME_ARM, data);
                        this.handleSensorRefreshLockout();
                        break;
                    case 9401:
                    case 9407:
                        // 9401 is for Keypad, 9407 is for Remote
                        this.emit(EVENT_TYPES.AWAY_EXIT_DELAY, data);
                        break;
                    case 3401:
                    case 3407:
                    case 3487:
                    case 3481:
                        // 3401 is for Keypad, 3407 is for Remote
                        this.emit(EVENT_TYPES.AWAY_ARM, data);
                        this.handleSensorRefreshLockout();
                        break;
                    case 1429:
                        this.emit(EVENT_TYPES.ENTRY, data);
                        break;
                    case 1110:
                    case 1154:
                    case 1159:
                    case 1162:
                    case 1132:
                    case 1134:
                    case 1120:
                        this.emit(EVENT_TYPES.ALARM_TRIGGER, data);
                        break;
                    case 1170:
                        this.emit(EVENT_TYPES.CAMERA_MOTION, data);
                        break;
                    case 1301:
                        this.emit(EVENT_TYPES.POWER_OUTAGE, data);
                        break;
                    case 3301:
                        this.emit(EVENT_TYPES.POWER_RESTORED, data);
                        break;
                    case 1458:
                        this.emit(EVENT_TYPES.DOORBELL, data);
                        break;
                    case 9700:
                        this.emit(EVENT_TYPES.DOORLOCK_UNLOCKED, data);
                        break;
                    case 9701:
                        this.emit(EVENT_TYPES.DOORLOCK_LOCKED, data);
                        break;
                    case 9703:
                        this.emit(EVENT_TYPES.DOORLOCK_ERROR, data);
                        break;
                    case 1350:
                        this.log.error('Base station WiFi lost, this plugin cannot communicate with the base station until it is restored.');
                        break;
                    case 3350:
                        this.log.warn('Base station WiFi restored.');
                        break;
                    case 1601:
                        // User-initiated test, handled above
                        break;
                    case 1602:
                        // Automatic test
                        break;
                    default:
                        // Unknown event
                        if (this.debug) this.log('Unknown SSAPI event:', data);
                        break;
                    }
                    break;
                }
            }
        });
    }

    handleSocketConnectionFailure() {
        if (this.lifecycle.signal.aborted || this.isAwaitingSocketReconnect) return; // a reconnect attempt is pending / running

        if (this.socket) {
            try {
                this.socket.removeAllListeners();
                this.socket.on('error', () => {});
                this.socket.terminate();
            } catch (error) {
                if (this.debug) this.log.warn('SSAPI socket error occurred during termination, perhaps socket was not yet established.', error);
            }
            this.socket = null;
        }

        clearInterval(this.socketHeartbeatIntervalID);
        this.socketIsAlive = false;

        // Keep outages from overflowing Node's timer or synchronizing clients.
        const baseInterval = Math.min(60000, (2 ** Math.min(this.nSocketConnectFailures, 6)) * socketRetryInterval);
        const retryInterval = Math.min(60000, Math.round(baseInterval * (1 + Math.random() * 0.2)));
        if (this.debug) this.log(`SSAPI socket connection lost. Next attempt will be in ${retryInterval/1000}s.`);
        this.socketReconnectTimeoutID = setTimeout(async () => {
            this.socketReconnectTimeoutID = undefined;
            this.isAwaitingSocketReconnect = false;
            try { await this.startListening(); }
            catch (err) { this.handleSocketConnectionFailure(); }
        }, retryInterval);
        this.nSocketConnectFailures++;
        this.isAwaitingSocketReconnect = true;
    }

    queuePoll(kind, subscriptions) {
        if (this.lifecycle.signal.aborted || !subscriptions.length) return;
        if (this.refreshLockoutTimeoutID) {
            if (this.debug) {
                this.log(kind === 'sensor' ? 'Sensor refresh lockout in effect, refresh blocked.' :
                    'Refresh lockout in effect, alarm system refresh blocked.');
            }
            return;
        }
        // A Set keeps the oldest due poll first and coalesces repeated ticks.
        this.pendingPolls.add(kind);
        return this.drainPolls();
    }

    async drainPolls() {
        if (this.pollInFlight) return;
        clearTimeout(this.pollCooldownTimeoutID);
        this.pollCooldownTimeoutID = undefined;
        this.pollInFlight = true;
        try {
            while (this.pendingPolls.size && !this.lifecycle.signal.aborted && !this.refreshLockoutTimeoutID) {
                const remainingCooldown = this.isBlocked ? this.nextAttempt - Date.now() : 0;
                if (remainingCooldown > 0) {
                    this.pollCooldownTimeoutID = setTimeout(() => this.drainPolls(), remainingCooldown);
                    return;
                }
                const [kind] = this.pendingPolls;
                this.pendingPolls.delete(kind);
                await this.poll(kind);
            }
        } finally {
            this.pollInFlight = false;
        }
    }

    async poll(kind) {
        const sensorPoll = kind === 'sensor';
        try {
            const devices = sensorPoll ? await this.getSensors(true) : [await this.getAlarmSystem(true)];
            for (const device of devices) {
                const subscriptions = sensorPoll ? this.sensorSubscriptions : this.alarmSubscriptions;
                subscriptions.filter(subscription => subscription.id === device.serial)
                    .forEach(subscription => subscription.callback(device));
            }
        } catch (err) {
            if (this.lifecycle.signal.aborted || err instanceof RateLimitError) return;
            if (!this.debug) {
                this.handleErrorSuppression();
                return;
            }
            const label = sensorPoll ? 'Sensor' : 'Alarm system';
            if (err.statusCode == 409) {
                const message = `${label} refresh received SettingsInProgress error from the SimpliSafe API.`;
                if (sensorPoll) {
                    this.log.debug(`${message} Note this does not necessarily indicate a problem, just that the base station was busy.`);
                } else {
                    this.log.warn(message);
                }
            } else {
                this.log.error(`${label} refresh received an error from the SimpliSafe API:`, err);
            }
        }
    }

    clearPendingPoll(kind) {
        this.pendingPolls.delete(kind);
        if (!this.pendingPolls.size) {
            clearTimeout(this.pollCooldownTimeoutID);
            this.pollCooldownTimeoutID = undefined;
        }
    }

    subscribeToSensor(id, callback) {
        if (this.lifecycle.signal.aborted) return () => {};
        if (!this.sensorRefreshIntervalID) {
            this.sensorRefreshIntervalID = setInterval(
                () => this.queuePoll('sensor', this.sensorSubscriptions), this.sensorRefreshTime);
        }

        const subscription = { id, callback };
        this.sensorSubscriptions.push(subscription);
        return () => {
            this.sensorSubscriptions = this.sensorSubscriptions.filter(item => item !== subscription);
            this.stopSensorPollingIfUnused();
        };
    }

    unsubscribeFromSensor(id) {
        this.sensorSubscriptions = this.sensorSubscriptions.filter(sub => sub.id !== id);
        this.stopSensorPollingIfUnused();
    }

    stopSensorPollingIfUnused() {
        if (this.sensorSubscriptions.length) return;
        clearInterval(this.sensorRefreshIntervalID);
        this.sensorRefreshIntervalID = undefined;
        this.clearPendingPoll('sensor');
    }

    subscribeToAlarmSystem(id, callback) {
        if (this.lifecycle.signal.aborted) return () => {};
        if (!this.alarmRefreshIntervalID) {
            this.alarmRefreshIntervalID = setInterval(
                () => this.queuePoll('alarm', this.alarmSubscriptions), alarmRefreshInterval);
        }

        const subscription = { id, callback };
        this.alarmSubscriptions.push(subscription);
        return () => {
            this.alarmSubscriptions = this.alarmSubscriptions.filter(item => item !== subscription);
            if (!this.alarmSubscriptions.length) {
                clearInterval(this.alarmRefreshIntervalID);
                this.alarmRefreshIntervalID = undefined;
                this.clearPendingPoll('alarm');
            }
        };
    }

    handleErrorSuppression() {
        if (this.lifecycle.signal.aborted) return;
        if (!this.errorSupperessionTimeoutID) {
            this.nSuppressedErrors = 1;
            this.errorSupperessionTimeoutID = setTimeout(() => {
                if (!this.debug && this.nSuppressedErrors > 0) this.log.warn(`${this.nSuppressedErrors} error${this.nSuppressedErrors > 1 ? 's were' : ' was'} received from the SimpliSafe API while refreshing sensors in the last ${errorSuppressionDuration / 60000} minutes. These can usually be ignored if everything is working. Otherwise, enable debug logging for the plugin and restart to see detailed output.`);
                clearTimeout(this.errorSupperessionTimeoutID);
                this.errorSupperessionTimeoutID = undefined;
            }, errorSuppressionDuration);
        } else {
            this.nSuppressedErrors++;
        }
    }

    handleSensorRefreshLockout() {
        if (this.lifecycle.signal.aborted) return;
        if (!this.refreshLockoutEnabled) return;
        // avoid "smart lock not responding" error with refresh lockout, see issue #134
        this.clearPendingPoll('sensor');
        this.clearPendingPoll('alarm');
        clearTimeout(this.refreshLockoutTimeoutID);
        this.refreshLockoutTimeoutID = setTimeout(() => {
            this.refreshLockoutTimeoutID = undefined;
        }, sensorRefreshLockoutDuration);
    }

    dispose() {
        if (this.lifecycle.signal.aborted) return;
        this.lifecycle.abort(new Error('SimpliSafe client stopped'));
        for (const timer of [this.sensorRefreshIntervalID, this.alarmRefreshIntervalID, this.socketHeartbeatIntervalID,
            this.socketReconnectTimeoutID, this.refreshLockoutTimeoutID, this.errorSupperessionTimeoutID,
            this.pollCooldownTimeoutID]) clearInterval(timer);
        this.pendingPolls.clear();
        this.authManager.off(AUTH_EVENTS.REFRESH_CREDENTIALS_FAILURE, this.authFailureListener);
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.on('error', () => {});
            this.socket.terminate();
            this.socket = null;
        }
        this.sensorSubscriptions = [];
        this.alarmSubscriptions = [];
        this.readCache.clear();
    }

}

export default SimpliSafe3;
