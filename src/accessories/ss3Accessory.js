import safeLogger from '../lib/safeLogger';
class SimpliSafe3Accessory {
    services = [];

    constructor (name, id, log, debug, simplisafe, api) {
        this.id = id;
        this.log = safeLogger(log);
        this.debug = debug;
        this.name = name;
        this.simplisafe = simplisafe;
        this.api = api;
        this.uuid = this.api.hap.uuid.generate(id);
    }

    identify(callback) {
        if (this.debug) this.log(`Identify request for ${this.name}`);
        callback();
    }

    createAccessory() {
        let newAccessory = new this.api.platformAccessory(this.name, this.uuid);
        this.setupServices(newAccessory);
        this.setAccessory(newAccessory);
        return newAccessory;
    }

    setAccessory(accessory) {
        this.accessory = accessory;
        this.listen(this.accessory, 'identify', (paired, callback) => this.identify(callback));
    }

    setupServices(accessory) {
        for (let service of this.services) {
            accessory.addService(service);
        }
    }

    listen(emitter, event, callback) {
        const listener = (...args) => {
            if (this.disposed) return;
            try {
                const result = callback(...args);
                result?.catch?.(err => this.log.error('Accessory event failed:', err));
                return result;
            } catch (err) { this.log.error('Accessory event failed:', err); }
        };
        emitter.on(event, listener);
        (this.cleanup ||= []).push(() => emitter.off(event, listener));
    }

    defer(callback, delay) {
        if (this.disposed) return;
        const timers = this.timers ||= new Set();
        const timer = setTimeout(() => {
            timers.delete(timer);
            if (!this.disposed) {
                try { callback()?.catch?.(err => this.log.error('Deferred accessory update failed:', err)); }
                catch (err) { this.log.error('Deferred accessory update failed:', err); }
            }
        }, delay);
        timers.add(timer);
        return timer;
    }

    cancelTimer(timer) {
        clearTimeout(timer);
        this.timers?.delete(timer);
    }

    subscribeSensor(callback) {
        const unsubscribe = this.simplisafe.subscribeToSensor(this.id, value => { if (!this.disposed) callback(value); });
        if (unsubscribe) (this.cleanup ||= []).push(unsubscribe);
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        for (const timer of this.timers || []) clearTimeout(timer);
        this.timers?.clear();
        for (const cleanup of this.cleanup || []) cleanup();
        this.cleanup = [];
        this.streamingDelegate?.dispose();
    }
}

export default SimpliSafe3Accessory;
