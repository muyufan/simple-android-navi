// Compares the TypeScript emitter output against the .classpath files that were verified
// to produce working navigation on termux-app-master.
const { planModel } = require('./model-test.cjs');
const fs = require('fs');
const path = require('path');

const ROOT = 'D:/code/android/workspace/termux-app-master';
const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'android-navi-model.json'), 'utf8'));
const plan = planModel(model, 'debug');

console.log('planned files:', plan.files.length, '| conflicts:', plan.conflicts.length, '| missingLibs:', plan.missingLibs.length);
const app = plan.files.find((f) => f.filePath.split(path.sep).join('/').endsWith('app/.classpath'));
console.log('--- generated :app .classpath (head) ---');
console.log(app.contents.split('\n').slice(0, 5).join('\n'));
console.log('... total lines:', app.contents.split('\n').length);

const parse = (s) => s.split('\n').filter((l) => l.includes('classpathentry')).map((l) => l.trim()).sort();
let allSame = true;
for (const f of plan.files.filter((x) => x.filePath.endsWith('.classpath'))) {
  const existing = fs.readFileSync(f.filePath, 'utf8');
  const a = parse(existing);
  const b = parse(f.contents);
  const missing = a.filter((x) => !b.includes(x));
  const extra = b.filter((x) => !a.includes(x));
  const same = missing.length === 0 && extra.length === 0;
  if (!same) allSame = false;
  console.log(f.filePath.replace(ROOT, ''), '| identical:', same, '| missing:', missing.length, '| extra:', extra.length);
  if (missing.length) console.log('    proven-good only:', missing.slice(0, 2));
  if (extra.length) console.log('    generated only  :', extra.slice(0, 2));
}
console.log(allSame ? 'RESULT: emitter reproduces the verified model exactly' : 'RESULT: DIFFERENCES (see above)');
