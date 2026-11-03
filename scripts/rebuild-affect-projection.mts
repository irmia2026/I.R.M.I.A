/**
 * Offline migration for an INTEGRATED IRMIA checkout.
 * Usage: node --experimental-strip-types scripts/rebuild-affect-projection.mts --data-dir <path> --confirm-offline
 * Main IRMIA process MUST be stopped, and dataDir backed up by the operator.
 * No historical event is rewritten. Rebuilds v4 cache/snapshot from append-only log.
 */
import {resolve,join} from 'node:path';
import {EventLog} from '../src/log/event-log.ts';
import {applyEvent,finalizePressure} from '../src/state/fold.ts';
import {emptyProjection} from '../src/log/types.ts';
import {acquireInstanceLock} from '../src/runtime/instance-lock.ts';
import {saveProjectionCache,PROJECTION_CACHE_VERSION} from '../src/state/projection-cache.ts';
import {writeSnapshot,SNAPSHOT_VERSION} from '../src/state/snapshot.ts';
const args=process.argv.slice(2),which=args.indexOf('--data-dir');
if(which<0||!args[which+1]||!args.includes('--confirm-offline')){
 console.error('Usage: --data-dir <dir> --confirm-offline (STOP IRMIA AND BACK UP DATA FIRST)');process.exitCode=2;
}else{
 const dir=resolve(args[which+1]!);
 // Acquire IRMIA's own singleton lock: --confirm-offline alone is not sufficient.
 const lock=await acquireInstanceLock(dir);
 let log:EventLog|null=null;
 try{
  log=await EventLog.open(join(dir,'events'));
  // EventLog.open can truncate an incomplete tail; refuse migration on any repaired log.
  if(log.repair!==null)throw new Error('Log tail needed repair; abort offline migration and use IRMIA recovery first');
  const state=emptyProjection(); let eventCount=0;
  for await(const e of log.readAll()){applyEvent(state,e);eventCount++;}
  finalizePressure(state);
  if(!state.affect||state.affect.version!==2)throw new Error('No integrated affect v2 state: run generator and compile first');
  await writeSnapshot(dir,state);
  await saveProjectionCache(dir,state,state.lastSeq);
  console.log(JSON.stringify({ok:true,from:'full-log',events:eventCount,lastSeq:state.lastSeq,cacheVersion:PROJECTION_CACHE_VERSION,snapshotVersion:SNAPSHOT_VERSION,affectStateVersion:state.affect.version}));
 }finally{log?.close();lock.release();}
}
