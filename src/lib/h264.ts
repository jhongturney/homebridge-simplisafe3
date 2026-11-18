// Drafted by Claude Opus 5.5

export const maxFrameBytes = 8 * 1024 * 1024;
const maxParts = 8192;
const startCode = Buffer.from([0, 0, 0, 1]);

// Subset of werift's RtpHeader that depacketization needs
export interface RtpHeaderFields {
    timestamp: number;
    marker: boolean;
    sequenceNumber: number;
}

interface Fragment {
    type: number;
    chunks: Buffer[];
    nextSequence: number;
    bytes: number;
}

// Collects a whole keyframe out of RTP payloads so a snapshot can be decoded from
// the live stream. Depacketization only, no decoding.
// A keyframe is usually several slices sharing one RTP timestamp, so NALs are
// gathered per access unit rather than kept individually
class KeyframeCollector {
    declare private sps: Buffer | null;
    declare private pps: Buffer | null;
    declare private keyframe: Buffer | null;
    declare private currentTimestamp: number | null;
    declare private accessUnit: Buffer[];
    declare private fragment: Fragment | null;
    private unitBytes = 0;
    private droppedTimestamp: number | null = null;

    constructor() {
        this.reset();
    }

    reset(): void {
        this.sps = null;
        this.pps = null;
        this.keyframe = null;
        this.currentTimestamp = null;
        this.accessUnit = [];
        this.fragment = null;
        this.unitBytes = 0;
        this.droppedTimestamp = null;
    }

    get complete(): boolean {
        return !!this.keyframe;
    }

    annexB(): Buffer | null {
        return this.keyframe;
    }

    push(payload: Buffer | null | undefined, header: RtpHeaderFields | null | undefined): void {
        if (this.keyframe || !payload || !payload.length || !header) return;
        const { timestamp, marker, sequenceNumber } = header;

        if (this.currentTimestamp !== null && timestamp !== this.currentTimestamp) {
            this._endAccessUnit();
        }
        if (this.keyframe) return;
        if (timestamp !== this.droppedTimestamp) this.droppedTimestamp = null;
        this.currentTimestamp = timestamp;
        if (this.droppedTimestamp === timestamp) return;
        if (payload.length > maxFrameBytes) { this.dropAccessUnit(); return; }

        const type = payload[0] & 0x1f;

        if (type >= 1 && type <= 23) {
            this._store(Buffer.from(payload));
        } else if (type === 24) { // STAP-A, several NALs in one packet
            let offset = 1;
            while (offset + 2 <= payload.length) {
                const length = payload.readUInt16BE(offset);
                offset += 2;
                if (offset + length > payload.length) break;
                this._store(Buffer.from(payload.subarray(offset, offset + length)));
                offset += length;
            }
        } else if (type === 28) { // FU-A, one NAL split across packets
            if (payload.length < 2) { this.dropAccessUnit(); return; }
            const fuHeader = payload[1];
            const nalType = fuHeader & 0x1f;

            if (fuHeader & 0x80) { // start
                this.fragment = {
                    type: nalType,
                    chunks: [Buffer.from([(payload[0] & 0x60) | nalType]), Buffer.from(payload.subarray(2))],
                    nextSequence: (sequenceNumber + 1) & 0xffff,
                    bytes: payload.length - 1
                };
            } else if (this.fragment && this.fragment.type === nalType) {
                // A gap means a lost or reordered fragment. Concatenating across it
                // yields a corrupt NAL and a smeared picture, so drop the whole frame
                if (sequenceNumber !== this.fragment.nextSequence) {
                    this.dropAccessUnit();
                    return;
                }
                this.fragment.bytes += payload.length - 2;
                if (this.fragment.bytes + this.unitBytes > maxFrameBytes || this.fragment.chunks.length >= maxParts) {
                    this.dropAccessUnit();
                    return;
                }
                this.fragment.chunks.push(Buffer.from(payload.subarray(2)));
                this.fragment.nextSequence = (sequenceNumber + 1) & 0xffff;
                if (fuHeader & 0x40) { // end
                    this._store(Buffer.concat(this.fragment.chunks));
                    this.fragment = null;
                }
            }
        }

        if (marker) this._endAccessUnit();
    }

    private _store(nal: Buffer): void {
        if (!nal.length || this.droppedTimestamp === this.currentTimestamp) return;
        const type = nal[0] & 0x1f;

        // Parameter sets are sent repeatedly, keep the latest outside the access unit
        if (type === 7 || type === 8) {
            if (nal.length > 65536) { this.dropAccessUnit(); return; }
            if (type === 7) this.sps = nal; else this.pps = nal;
        } else {
            this.unitBytes += nal.length + startCode.length;
            if (this.unitBytes > maxFrameBytes || this.accessUnit.length >= maxParts) { this.dropAccessUnit(); return; }
            this.accessUnit.push(nal);
        }
    }

    // An access unit holding an IDR is a complete keyframe, emit every slice of it
    private _endAccessUnit(): void {
        if (this.keyframe) { this.accessUnit = []; return; }

        const hasIdr = this.droppedTimestamp !== this.currentTimestamp && this.accessUnit.some(nal => (nal[0] & 0x1f) === 5);
        if (hasIdr && this.sps && this.pps) {
            const parts = [startCode, this.sps, startCode, this.pps];
            for (const nal of this.accessUnit) parts.push(startCode, nal);
            this.keyframe = Buffer.concat(parts);
        }

        this.accessUnit = [];
        this.unitBytes = 0;
        this.fragment = null;
    }

    private dropAccessUnit(): void {
        this.droppedTimestamp = this.currentTimestamp;
        this.accessUnit = [];
        this.unitBytes = 0;
        this.fragment = null;
    }
}

export default KeyframeCollector;
