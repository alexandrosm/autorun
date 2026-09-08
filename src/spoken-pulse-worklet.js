// Only compact energy frames leave the audio thread; no PCM recording is retained here.
class SpokenPulseMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samplesPerFrame = Math.round(sampleRate * 0.01);
    this.sampleCount = 0;
    this.sumSquares = 0;
    this.clippedCount = 0;
    this.frameStart = 0;
    this.frames = [];
    this.port.onmessage = (event) => {
      if (event.data?.type === "flush" && this.frames.length) {
        this.port.postMessage({ frames: this.frames });
        this.frames = [];
      }
    };
  }

  process(inputs, outputs) {
    // Never play the microphone through the destination connection.
    for (const output of outputs) {
      for (const channel of output) channel.fill(0);
    }
    const input = inputs[0]?.[0];
    if (!input) {
      // Missing input is missing evidence, not a fabricated silent sample.
      this.sampleCount = 0;
      this.sumSquares = 0;
      this.clippedCount = 0;
      return true;
    }
    for (let i = 0; i < input.length; i++) {
      if (this.sampleCount === 0) this.frameStart = currentTime + i / sampleRate;
      const value = input[i];
      this.sumSquares += value * value;
      if (Math.abs(value) >= 0.98) this.clippedCount++;
      this.sampleCount++;
      if (this.sampleCount === this.samplesPerFrame) {
        this.frames.push({
          time_seconds: this.frameStart,
          rms: Math.sqrt(this.sumSquares / this.sampleCount),
          clipped_fraction: this.clippedCount / this.sampleCount,
        });
        this.sampleCount = 0;
        this.sumSquares = 0;
        this.clippedCount = 0;
        if (this.frames.length === 5) {
          this.port.postMessage({ frames: this.frames });
          this.frames = [];
        }
      }
    }
    return true;
  }
}

registerProcessor("spoken-pulse-meter", SpokenPulseMeter);
