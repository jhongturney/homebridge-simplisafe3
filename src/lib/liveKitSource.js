import WebSocket from 'ws';
import { RTCPeerConnection, RTCRtpCodecParameters } from 'werift';
import {
    SignalRequest,
    SignalResponse,
    SessionDescription,
    TrickleRequest,
    SignalTarget
} from '@livekit/protocol';

const trackTimeout = 30000; // ms, how long to wait for the camera's video track

// LiveKit subscriber. werift gives the encoded RTP so H.264 can be passed to HomeKit untouched
class LiveKitSource {
    constructor(ss3Camera) {
        this.ss3Camera = ss3Camera;
        this.simplisafe = ss3Camera.simplisafe;
        this.log = ss3Camera.log;
        this.debug = ss3Camera.debug;

        this.onVideoRtp = null;
        this.onAudioRtp = null;
        this.onSessionEnded = null;

        this.ws = null;
        this.pc = null;
        this.pingIntervalID = null;
        this.closed = false;
        this.streaming = false;
    }

    // Fires only when a running session dies on us, not on a deliberate close
    _sessionEnded(reason) {
        if (this.closed || !this.streaming) return;
        const notify = this.onSessionEnded;
        this.close();
        if (notify) notify(reason);
    }

    // Resolves once the first video RTP packet arrives i.e. media is flowing
    connect() {
        if (this.closed) return Promise.reject(new Error('LiveKit session closed'));
        if (this.connectPromise) return this.connectPromise;
        this.controller = new AbortController();
        const signal = this.controller.signal;
        let onAbort;
        const cancelled = new Promise((resolve, reject) => {
            onAbort = () => reject(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
        });
        const timer = setTimeout(() => this.controller.abort(new Error(`Timed out after ${trackTimeout}ms waiting for video from ${this.ss3Camera.name}.`)), trackTimeout);
        this.connectPromise = Promise.race([this._connect(signal), cancelled])
            .catch(err => { this.close(); throw err; })
            .finally(() => {
                clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
                this._onFirstVideo = null;
                this._settleConnection = null;
            });
        return this.connectPromise;
    }

    async _connect(signal) {
        try {
            await this.simplisafe.wakeCameras(signal);
        } catch (err) {
            if (this.debug) this.log(`LiveKit: wake request failed, continuing: ${err.message}`);
        }

        signal.throwIfAborted();
        const liveView = await this.simplisafe.getCameraLiveView(this.ss3Camera.id, signal);
        signal.throwIfAborted();
        if (this.debug) this.log(`LiveKit: ${this.ss3Camera.name} cameraStatus ${liveView.cameraStatus}`);

        const url = `${liveView.liveKitURL}/rtc?access_token=${liveView.userToken}&auto_subscribe=1&protocol=15&sdk=js&version=2.22.3`;
        this.ws = new WebSocket(url);

        // LiveKit renegotiates repeatedly as tracks appear
        // Serialize offers so werift doesnt throw
        let offerChain = Promise.resolve();

        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (err) => {
                if (settled) return;
                settled = true;
                if (err) reject(err); else resolve();
            };

            this._settleConnection = settle;

            const send = (message) => {
                if (this.closed) return;
                try {
                    this.ws.send(new SignalRequest(message).toBinary());
                } catch (err) {
                    if (this.debug) this.log.error('LiveKit: failed to send signal:', err.message);
                }
            };

            this.ws.on('error', err => { settle(err); this._sessionEnded(err.message); this.close(); });
            this.ws.on('close', () => {
                settle(new Error('LiveKit signalling closed before video started'));
                this._sessionEnded('signalling closed');
                this.close();
            });

            this.ws.on('message', async data => {
                if (this.closed) return;
                let response;
                try {
                    response = SignalResponse.fromBinary(new Uint8Array(data));
                } catch (err) {
                    return;
                }

                const message = response.message;

                switch (message.case) {
                case 'join':
                    this._handleJoin(message.value, send);
                    break;

                case 'offer': {
                    const sdp = message.value.sdp;
                    offerChain = offerChain
                        .then(async () => {
                            if (this.closed || !this.pc) return;
                            const pc = this.pc;
                            await pc.setRemoteDescription({ type: 'offer', sdp: sdp });
                            if (this.closed) return;
                            const answer = await pc.createAnswer();
                            if (this.closed) return;
                            await pc.setLocalDescription(answer);
                            send({ message: { case: 'answer', value: new SessionDescription({ type: 'answer', sdp: pc.localDescription.sdp }) } });
                        })
                        .catch(err => {
                            if (this.debug) this.log.error('LiveKit: negotiation failed:', err.message);
                        });
                    break;
                }

                case 'trickle':
                    try {
                        await this.pc.addIceCandidate(JSON.parse(message.value.candidateInit));
                    } catch (err) {
                        if (this.debug) this.log.error('LiveKit: bad ICE candidate:', err.message);
                    }
                    break;

                case 'leave':
                    if (this.debug) this.log('LiveKit: server ended the session');
                    settle(new Error('LiveKit server ended the session'));
                    this._sessionEnded('server ended the session');
                    this.close();
                    break;
                }
            });

            this._onFirstVideo = () => settle();
        });
    }

    _handleJoin(join, send) {
        if (this.closed || this.pc) return;
        if (this.debug) this.log(`LiveKit: joined room ${join.room && join.room.name}`);

        this.pc = new RTCPeerConnection({
            iceServers: (join.iceServers || []).map(server => ({
                urls: server.urls,
                username: server.username || undefined,
                credential: server.credential || undefined
            })),
            codecs: {
                // Explicitly request H.264
                video: [new RTCRtpCodecParameters({
                    mimeType: 'video/H264',
                    clockRate: 90000,
                    payloadType: 96,
                    rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'goog-remb' }],
                    parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f'
                })],
                audio: [new RTCRtpCodecParameters({
                    mimeType: 'audio/opus',
                    clockRate: 48000,
                    channels: 2,
                    payloadType: 111
                })]
            }
        });

        this.pc.connectionStateChange.subscribe(state => {
            if (this.debug) this.log(`LiveKit: connection ${state} for ${this.ss3Camera.name}`);
            if (state === 'failed') {
                this._settleConnection?.(new Error('LiveKit media connection failed'));
                this._sessionEnded('media connection failed');
                this.close();
            }
        });

        this.pc.onIceCandidate.subscribe(candidate => {
            if (!candidate) return;
            send({ message: { case: 'trickle', value: new TrickleRequest({ candidateInit: JSON.stringify(candidate), target: SignalTarget.SUBSCRIBER }) } });
        });

        this.pc.onTrack.subscribe(track => {
            if (this.debug) this.log(`LiveKit: subscribed to ${track.kind} (${track.codec && track.codec.mimeType})`);

            track.onReceiveRtp.subscribe(rtp => {
                if (this.closed) return;

                if (track.kind === 'video') {
                    this.streaming = true;
                    if (this._onFirstVideo) {
                        const notify = this._onFirstVideo;
                        this._onFirstVideo = null;
                        notify();
                    }
                    if (this.onVideoRtp) this.onVideoRtp(rtp);
                } else if (this.onAudioRtp) {
                    this.onAudioRtp(rtp);
                }
            });
        });

        if (join.pingInterval) {
            this.pingIntervalID = setInterval(() => {
                send({ message: { case: 'ping', value: BigInt(Date.now()) } });
            }, join.pingInterval * 1000);
        }
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        const error = new Error('LiveKit session closed');
        this.controller?.abort(error);
        this._settleConnection?.(error);
        this._onFirstVideo = null;

        clearInterval(this.pingIntervalID);
        this.streaming = false;
        this.onVideoRtp = null;
        this.onAudioRtp = null;
        this.onSessionEnded = null;

        try {
            if (this.pc) Promise.resolve(this.pc.close()).catch(() => {});
        } catch (err) { /* already gone */ }

        try {
            if (this.ws) {
                // A connecting ws emits an error when terminated; retain a sink for it.
                this.ws.removeAllListeners();
                this.ws.on('error', () => {});
                this.ws.terminate();
            }
        } catch (err) { /* already gone */ }

        this.pc = null;
        this.ws = null;
    }
}

export default LiveKitSource;
