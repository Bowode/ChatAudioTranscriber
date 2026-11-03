import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function acquireInstanceLock(filename) {
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const databasePath = fs.existsSync(filename) ? fs.realpathSync(filename)
    : path.join(fs.realpathSync(path.dirname(path.resolve(filename))), path.basename(filename));
  const lockPath = `${databasePath}.lock`;
  const gate = `${lockPath}.acquiring`;
  let gateFd;
  try { gateFd = fs.openSync(gate, 'wx'); }
  catch { throw new Error('Lock acquisition/recovery is already in progress; do not remove an unknown lock'); }
  const token = randomUUID();
  try {
    if (fs.existsSync(lockPath)) {
      let owner;
      try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { throw new Error('Corrupt instance lock; refusing recovery'); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !owner.token || owner.databasePath !== databasePath) throw new Error('Invalid instance lock; refusing recovery');
      try { process.kill(owner.pid, 0); throw new Error(`Instance lock active: PID ${owner.pid}`); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      fs.unlinkSync(lockPath); // Serialized by the atomic acquiring gate; PID confirmed absent.
    }
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), databasePath, token }), { flag: 'wx' });
  } finally { fs.closeSync(gateFd); fs.unlinkSync(gate); }
  let released = false;
  const assertOwned = () => {
    if (released || JSON.parse(fs.readFileSync(lockPath, 'utf8')).token !== token) throw new Error('Instance lock ownership lost');
  };
  const release = () => {
    if (released) return;
    assertOwned();
    fs.unlinkSync(lockPath); released = true;
    process.removeListener('exit', onExit);
  };
  const onExit = () => { try { release(); } catch { /* Never remove another owner's lock. */ } };
  process.on('exit', onExit);
  return { lockPath, token, assertOwned, release };
}
