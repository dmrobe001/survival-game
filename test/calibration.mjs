// Calibration checks: whole-task times the game's numbers should reproduce.
// The benchmarks and their ranges live in tools/benchmarks.mjs; the full
// report (with the parameter table and sensitivities) is tools/calibrate.mjs.
// Run with:  node test/calibration.mjs
import { BENCH, runBench } from '../tools/benchmarks.mjs';

let failures = 0;
for (const b of BENCH) {
  const r = runBench(b);
  const line = `${b.name}: ${r.v.toFixed(2)} ${b.unit} (expected ${b.range[0]}-${b.range[1]})`;
  if (!r.ok) { failures++; console.log('  OUT OF RANGE: ' + line); }
}
console.log(failures ? `calibration: ${failures} of ${BENCH.length} benchmarks out of range` : `calibration: all ${BENCH.length} benchmarks in range`);
process.exit(failures ? 1 : 0);
