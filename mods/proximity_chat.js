// Copyright (c) 2026 cwcinc. All rights reserved. Unauthorized use prohibited.

const VOICE_BUFFER_SIZE = 1024;

function encodeAudio(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16.buffer;
}

function decodeAudio(arrayBuffer) {
  const int16 = new Int16Array(arrayBuffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] < 0 ? int16[i] / 0x8000 : int16[i] / 0x7FFF;
  }
  return float32;
}

class AudioRingBuffer {
  constructor() {
    this.buf = new Float32Array(16384);
    this.w = 0;
    this.r = 0;
  }
  write(samples) {
    for (let i = 0; i < samples.length; i++) {
      this.buf[(this.w++) & 16383] = samples[i];
    }
  }
  read(output) {
    for (let i = 0; i < output.length; i++) {
      output[i] = this.r < this.w ? this.buf[(this.r++) & 16383] : 0;
    }
  }
}

// ---- Client ----

class ClientVoiceChat {
  constructor({ refDistance = 5, maxDistance = 100, rolloffFactor = 1.5 } = {}) {
    this.refDistance = refDistance;
    this.maxDistance = maxDistance;
    this.rolloffFactor = rolloffFactor;

    this.audioCtx = null;
    this.destination = null;
    this.localStream = null;
    this._audioChannel = null;
    this._micCapture = null;

    // playerId -> { ringBuffer, sourceNode, panner, gain, keepAlive, getPosition }
    this.players = new Map();
    this._positionInterval = setInterval(() => this._updatePositions(), 50);
  }

  setAudioContext(audioCtx, destination) {
    this.audioCtx = audioCtx;
    this.destination = destination;

    for (const [, player] of this.players) {
      this._reconnectPlayer(player);
    }

    this._trySetupMic();
  }

  async start(peerConnection) {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      this.localStream.getAudioTracks().forEach(t => (t.enabled = false));
    } catch (e) {
      this.localStream = null;
      console.warn('[voice] mic not available', e);
    }

    this._audioChannel = peerConnection.createDataChannel("voice-audio", {
      negotiated: true, id: 2, ordered: false, maxRetransmits: 0
    });
    this._audioChannel.binaryType = "arraybuffer";

    this._audioChannel.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer) || event.data.byteLength <= 4) return;

      const playerId = new DataView(event.data).getUint32(0, true);
      const samples = decodeAudio(event.data.slice(4));

      let player = this.players.get(playerId);
      if (!player) player = this._createPlayerAudio(playerId);
      player.ringBuffer.write(samples);
    };

    this._trySetupMic();
  }

  _trySetupMic() {
    if (this._micCapture || !this.localStream || !this.audioCtx) return;

    const source = this.audioCtx.createMediaStreamSource(this.localStream);
    const processor = this.audioCtx.createScriptProcessor(VOICE_BUFFER_SIZE, 1, 1);

    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const output = e.outputBuffer.getChannelData(0);
      for (let i = 0; i < output.length; i++) output[i] = 0;

      if (this._audioChannel?.readyState === 'open') {
        try { this._audioChannel.send(encodeAudio(input)); } catch {}
      }
    };

    source.connect(processor);
    processor.connect(this.audioCtx.destination);
    this._micCapture = { source, processor };
  }

  _createPlayerAudio(playerId) {
    const ringBuffer = new AudioRingBuffer();
    const player = {
      ringBuffer, sourceNode: null, panner: null,
      gain: null, keepAlive: null, getPosition: null
    };
    this.players.set(playerId, player);

    if (this.audioCtx && this.destination) {
      this._reconnectPlayer(player);
    }

    return player;
  }

  _reconnectPlayer(player) {
    if (player.sourceNode) player.sourceNode.disconnect();
    if (player.panner) player.panner.disconnect();
    if (player.gain) player.gain.disconnect();
    if (player.keepAlive) player.keepAlive.disconnect();

    if (!this.audioCtx || !this.destination) return;

    const sourceNode = this.audioCtx.createScriptProcessor(VOICE_BUFFER_SIZE, 0, 1);
    sourceNode.onaudioprocess = (e) => {
      player.ringBuffer.read(e.outputBuffer.getChannelData(0));
    };

    const panner = this.audioCtx.createPanner();
    panner.refDistance = this.refDistance;
    panner.maxDistance = this.maxDistance;
    panner.rolloffFactor = this.rolloffFactor;

    const gain = this.audioCtx.createGain();
    gain.gain.value = 1;

    sourceNode.connect(panner).connect(gain).connect(this.destination);

    const keepAlive = this.audioCtx.createGain();
    keepAlive.gain.value = 0;
    sourceNode.connect(keepAlive).connect(this.audioCtx.destination);

    player.sourceNode = sourceNode;
    player.panner = panner;
    player.gain = gain;
    player.keepAlive = keepAlive;
  }

  setPlayerPosition(playerId, getPositionFn) {
    let player = this.players.get(playerId);
    if (!player) player = this._createPlayerAudio(playerId);
    player.getPosition = getPositionFn;
  }

  _updatePositions() {
    for (const [, player] of this.players) {
      if (!player.panner || !player.getPosition) continue;
      const pos = player.getPosition();
      if (!pos) continue;
      player.panner.positionX.value = pos.x;
      player.panner.positionY.value = pos.y;
      player.panner.positionZ.value = pos.z ?? 0;
    }
  }

  setMicMuted(muted) {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(t => (t.enabled = !muted));
    }
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    if (player.sourceNode) player.sourceNode.disconnect();
    if (player.panner) player.panner.disconnect();
    if (player.gain) player.gain.disconnect();
    if (player.keepAlive) player.keepAlive.disconnect();
    this.players.delete(playerId);
  }

  destroy() {
    clearInterval(this._positionInterval);
    if (this.localStream) this.localStream.getTracks().forEach(t => t.stop());
    if (this._micCapture) {
      this._micCapture.source.disconnect();
      this._micCapture.processor.disconnect();
    }
    for (const [id] of this.players) this.removePlayer(id);
  }
}

// ---- Host ----

class HostVoiceChat {
  constructor({ refDistance = 5, maxDistance = 100, rolloffFactor = 1.5, hostId = 0 } = {}) {
    this.refDistance = refDistance;
    this.maxDistance = maxDistance;
    this.rolloffFactor = rolloffFactor;
    this.hostId = hostId;

    this.audioCtx = null;
    this.destination = null;
    this.localStream = null;
    this._micCapture = null;

    // playerId -> { peerConnection, audioChannel, ringBuffer, sourceNode, panner, gain, keepAlive, getPosition }
    this.clients = new Map();
    this._positionInterval = setInterval(() => this._updatePositions(), 50);
  }

  setAudioContext(audioCtx, destination) {
    this.audioCtx = audioCtx;
    this.destination = destination;

    for (const [, client] of this.clients) {
      this._reconnectClient(client);
    }

    this._trySetupMic();
  }

  async startHostMic() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      this.localStream.getAudioTracks().forEach(t => (t.enabled = false));
      this._trySetupMic();
      return this.localStream;
    } catch (e) {
      this.localStream = null;
      console.warn('[voice] host mic not available', e);
      return null;
    }
  }

  _trySetupMic() {
    if (this._micCapture || !this.localStream || !this.audioCtx) return;

    const source = this.audioCtx.createMediaStreamSource(this.localStream);
    const processor = this.audioCtx.createScriptProcessor(VOICE_BUFFER_SIZE, 1, 1);

    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const output = e.outputBuffer.getChannelData(0);
      for (let i = 0; i < output.length; i++) output[i] = 0;

      const tagged = this._tagAudio(this.hostId, encodeAudio(input));
      for (const [, client] of this.clients) {
        if (client.audioChannel?.readyState === 'open') {
          try { client.audioChannel.send(tagged); } catch {}
        }
      }
    };

    source.connect(processor);
    processor.connect(this.audioCtx.destination);
    this._micCapture = { source, processor };
  }

  _tagAudio(playerId, int16ArrayBuffer) {
    const tagged = new ArrayBuffer(4 + int16ArrayBuffer.byteLength);
    new DataView(tagged).setUint32(0, playerId, true);
    new Uint8Array(tagged, 4).set(new Uint8Array(int16ArrayBuffer));
    return tagged;
  }

  registerClient(playerId, peerConnection) {
    const ringBuffer = new AudioRingBuffer();

    const audioChannel = peerConnection.createDataChannel("voice-audio", {
      negotiated: true, id: 2, ordered: false, maxRetransmits: 0
    });
    audioChannel.binaryType = "arraybuffer";

    audioChannel.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer) || event.data.byteLength === 0) return;

      ringBuffer.write(decodeAudio(event.data));

      const tagged = new ArrayBuffer(4 + event.data.byteLength);
      new DataView(tagged).setUint32(0, playerId, true);
      new Uint8Array(tagged, 4).set(new Uint8Array(event.data));

      for (const [otherId, other] of this.clients) {
        if (otherId !== playerId && other.audioChannel?.readyState === 'open') {
          try { other.audioChannel.send(tagged); } catch {}
        }
      }
    };

    const client = {
      peerConnection, audioChannel, ringBuffer,
      sourceNode: null, panner: null, gain: null, keepAlive: null,
      getPosition: null
    };
    this.clients.set(playerId, client);

    if (this.audioCtx && this.destination) {
      this._reconnectClient(client);
    }
  }

  _reconnectClient(client) {
    if (client.sourceNode) client.sourceNode.disconnect();
    if (client.panner) client.panner.disconnect();
    if (client.gain) client.gain.disconnect();
    if (client.keepAlive) client.keepAlive.disconnect();

    if (!this.audioCtx || !this.destination) return;

    const sourceNode = this.audioCtx.createScriptProcessor(VOICE_BUFFER_SIZE, 0, 1);
    sourceNode.onaudioprocess = (e) => {
      client.ringBuffer.read(e.outputBuffer.getChannelData(0));
    };

    const panner = this.audioCtx.createPanner();
    panner.refDistance = this.refDistance;
    panner.maxDistance = this.maxDistance;
    panner.rolloffFactor = this.rolloffFactor;

    const gain = this.audioCtx.createGain();
    gain.gain.value = 1;

    sourceNode.connect(panner).connect(gain).connect(this.destination);

    const keepAlive = this.audioCtx.createGain();
    keepAlive.gain.value = 0;
    sourceNode.connect(keepAlive).connect(this.audioCtx.destination);

    client.sourceNode = sourceNode;
    client.panner = panner;
    client.gain = gain;
    client.keepAlive = keepAlive;
  }

  setPlayerPosition(playerId, getPositionFn) {
    const client = this.clients.get(playerId);
    if (client) client.getPosition = getPositionFn;
  }

  _updatePositions() {
    for (const [, client] of this.clients) {
      if (!client.panner || !client.getPosition) continue;
      const pos = client.getPosition();
      if (!pos) continue;
      client.panner.positionX.value = pos.x;
      client.panner.positionY.value = pos.y;
      client.panner.positionZ.value = pos.z ?? 0;
    }
  }

  setMicMuted(muted) {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(t => (t.enabled = !muted));
    }
  }

  removeClient(playerId) {
    const client = this.clients.get(playerId);
    if (!client) return;
    if (client.sourceNode) client.sourceNode.disconnect();
    if (client.panner) client.panner.disconnect();
    if (client.gain) client.gain.disconnect();
    if (client.keepAlive) client.keepAlive.disconnect();
    this.clients.delete(playerId);
  }

  destroy() {
    clearInterval(this._positionInterval);
    if (this.localStream) this.localStream.getTracks().forEach(t => t.stop());
    if (this._micCapture) {
      this._micCapture.source.disconnect();
      this._micCapture.processor.disconnect();
    }
    for (const [id] of this.clients) this.removeClient(id);
  }
}