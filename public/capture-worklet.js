// マイク入力を 128 サンプル単位でメインスレッドへ渡すだけの AudioWorklet
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("capture", Capture);
