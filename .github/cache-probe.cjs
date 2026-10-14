"use strict";
const http = require("node:http");
const { performance } = require("node:perf_hooks");
const states = new WeakMap();
const write = process.stdout.write.bind(process.stdout);
const log = (value) => write(`CACHE_PROBE ${JSON.stringify(value)}\n`);
const timeoutMessage = "Aborting download, socket timed out after 5000 ms";
process.stdout.write = function (chunk, ...args) {
  if (String(chunk).includes(timeoutMessage))
    log({ event: "client_inactivity_timeout", timeout_ms: 5000 });
  return write(chunk, ...args);
};
const requestEmit = http.ClientRequest.prototype.emit;
http.ClientRequest.prototype.emit = function (event, ...args) {
  if (event === "response") {
    const response = args[0];
    const expected = Number(response.headers["content-length"]);
    if (expected > 50 * 1024 * 1024) {
      const now = performance.now();
      states.set(response, {
        start: now,
        last: now,
        first: null,
        maxGap: 0,
        bytes: 0,
        expected,
        chunks: 0,
      });
      log({ event: "response", status: response.statusCode, expected_bytes: expected });
    }
  }
  return requestEmit.call(this, event, ...args);
};
const responseEmit = http.IncomingMessage.prototype.emit;
http.IncomingMessage.prototype.emit = function (event, ...args) {
  const state = states.get(this);
  if (state) {
    const now = performance.now();
    if (event === "data") {
      state.first ??= now;
      state.maxGap = Math.max(state.maxGap, now - state.last);
      state.last = now;
      state.bytes += args[0].length;
      state.chunks++;
    } else if (["end", "error", "aborted", "close"].includes(event)) {
      log({
        event,
        bytes: state.bytes,
        expected_bytes: state.expected,
        chunks: state.chunks,
        elapsed_ms: Math.round(now - state.start),
        last_data_gap_ms: Math.round(now - state.last),
        max_data_gap_ms: Math.round(state.maxGap),
        first_data_ms: state.first === null ? null : Math.round(state.first - state.start),
      });
      if (event === "close") states.delete(this);
    }
  }
  return responseEmit.call(this, event, ...args);
};
log({ event: "installed", node: process.version });
