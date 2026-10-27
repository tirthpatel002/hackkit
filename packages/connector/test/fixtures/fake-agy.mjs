#!/usr/bin/env node

const sleepMs = Number(process.env.FAKE_AGY_SLEEP_MS || 0);
const exitCodeStr = process.env.FAKE_AGY_EXIT_CODE;
const exitCode = exitCodeStr !== undefined ? Number(exitCodeStr) : null;
const stderrMsg = process.env.FAKE_AGY_STDERR;
const output = process.env.FAKE_AGY_OUTPUT;

function run() {
  if (exitCode !== null && exitCode !== 0) {
    if (stderrMsg !== undefined) {
      process.stderr.write(stderrMsg);
    }
    process.exit(exitCode);
  }

  if (output !== undefined) {
    process.stdout.write(output);
  } else {
    process.stdout.write(JSON.stringify(process.argv.slice(2)));
  }
  process.exit(0);
}

if (sleepMs > 0) {
  setTimeout(run, sleepMs);
} else {
  run();
}
