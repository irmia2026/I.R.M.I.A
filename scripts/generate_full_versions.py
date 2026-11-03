#!/usr/bin/env python3
"""Generate COMPLETE replacement files from the currently checked-out IRMIA source.

This is intentionally anchor based, not line-number based. It does NOT overwrite the repo;
all outputs are fully materialized under --out. Unknown upstream structures fail closed.
"""
from __future__ import annotations
import argparse
from pathlib import Path
import re

MODIFIED = [
 'src/log/types.ts','src/state/fold.ts','src/state/projection-cache.ts',
 'src/state/snapshot.ts','src/model/render.ts','src/runtime/agent-loop.ts',
 'src/runtime/real-loop.ts','src/runtime/replay.ts',
]

def once(data: str, before: str, after: str, desc: str) -> str:
    if after in data and before not in data:
        raise ValueError(f'{desc}: looks already patched: refusing to double-integrate')
    count=data.count(before)
    if count != 1: raise ValueError(f'{desc}: expected anchor once, found {count}: {before[:120]!r}')
    return data.replace(before,after,1)

def regex1(data:str, pattern:str, replacement,desc:str)->str:
    result,n=re.subn(pattern,replacement,data,count=0,flags=re.M)
    if n!=1:raise ValueError(f'{desc}: regex anchor found {n}')
    return result

def apply(path:str,s:str)->str:
    if path=='src/log/types.ts':
        s=once(s,"import type { CacheBreak, ContextBreakdown } from '../model/context-audit.js';", "import type { CacheBreak, ContextBreakdown } from '../model/context-audit.js';\n// affect integration: symbols required: EventEnvelope, StepStart, Projection, emptyProjection\nimport type { AffectState, AffectAppraisedData, AffectStepReceipt } from '../affect/types.js';\nimport { initialAffect } from '../affect/engine.ts';",'types imports')
        s=once(s,"export interface StepStart extends EventEnvelope<'step/start', {", "export interface StepStart extends EventEnvelope<'step/start', {\n  affect?: AffectStepReceipt;",'StepStart receipt')
        s=once(s,"// ──────────────────────────────── 联合类型 ────────────────────────────────", "// Affect ledger records are internal, not model-visible messages.\nexport interface AffectAppraised extends EventEnvelope<'affect/appraised', AffectAppraisedData> {}\n\n// ──────────────────────────────── 联合类型 ────────────────────────────────",'event interface')
        s=once(s,"export type AppEvent =\n", "export type AppEvent =\n  | AffectAppraised\n",'AppEvent union')
        s=once(s,"export const EVENT_VISIBILITY: Record<string, Visibility> = {", "export const EVENT_VISIBILITY: Record<string, Visibility> = {\n  'affect/appraised': 'internal',",'visibility')
        s=once(s,"export interface Projection {\n", "export interface Projection {\n  affect: AffectState;\n",'projection')
        s=once(s,"export function emptyProjection(): Projection {\n  return {", "export function emptyProjection(): Projection {\n  return {\n    affect: initialAffect(),",'initial projection')
        s=once(s,"export interface BudgetConsumed extends EventEnvelope<'budget/consumed', {", "export interface BudgetConsumed extends EventEnvelope<'budget/consumed', {\n  /** Auxiliary affect light evaluation: account tokens without changing global failStreak. */\n  affectEvaluation?: true;",'BudgetConsumed affect flag')
    elif path=='src/state/fold.ts':
        s="// affect integration: requires applyOne switch and Projection.affect\nimport { applyAppraised } from '../affect/engine.ts';\n"+s
        s=once(s,"  switch (e.type) {\n    case 'turn/start':", "  switch (e.type) {\n    case 'affect/appraised':\n      p.affect = applyAppraised(p.affect,e.data);\n      break;\n    case 'turn/start':",'fold applyOne switch')
        s=once(s,"  if (d.finishReason === 'failed') {\n    p.failStreak += 1;\n  } else {\n    p.failStreak = 0;\n    p.lastModelSuccessAt = e.ts;\n  }","  // Ancillary affect appraisal must not alter heavy/runtime health probes.\n  if (d.affectEvaluation !== true) {\n    if (d.finishReason === 'failed') {\n      p.failStreak += 1;\n    } else {\n      p.failStreak = 0;\n      p.lastModelSuccessAt = e.ts;\n    }\n  }",'light affect failStreak isolation')
    elif path=='src/state/projection-cache.ts':
        s=regex1(s,r'export const PROJECTION_CACHE_VERSION = (\d+);', lambda m: f'export const PROJECTION_CACHE_VERSION = {int(m[1])+1};', 'cache version bump')
        s=once(s,"import type { Projection } from '../log/types.js';","import type { Projection } from '../log/types.js';\nimport { assertEvaluated } from '../affect/index.ts';",'index integrity import')
        s=once(s,"export function basicProjectionShape(value: unknown): value is Projection {", "export function basicProjectionShape(value: unknown): value is Projection {", 'projection shape marker')
        s=once(s,"  if (!isRecord(value)) return false;\n  for (const key of NUMBER_KEYS)", "  if (!isRecord(value)) return false;\n  // affect: presence + version checked on both cache and snapshot restore paths.\n  const a = value['affect'];\n  if (!isRecord(a) || a['version'] !== 2 || !isRecord(a['emotions'])\n    || !isRecord(a['mood']) || !isRecord(a['evaluated'])\n    || !Array.isArray(a['causes']) || typeof a['atMs'] !== 'number') return false;\n  for (const key of ['joy','distress','concern','irritation','warmth','curiosity']) {\n    const n = a['emotions'][key]; if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) return false;\n  }\n  if (typeof a['mood']['valence'] !== 'number' || typeof a['mood']['arousal'] !== 'number'\n    || !Number.isFinite(a['mood']['valence']) || !Number.isFinite(a['mood']['arousal'])) return false;\n  if (a['evaluated']['version'] !== 1 || !Array.isArray(a['evaluated']['chunks'])) return false;\n  try { assertEvaluated(a['evaluated'] as any); } catch { return false; }\n  if (a['mood']['valence'] < -1 || a['mood']['valence'] > 1 || a['mood']['arousal'] < 0 || a['mood']['arousal'] > 1) return false;\n  if (!Number.isSafeInteger(a['atMs']) || a['atMs'] < 0 || a['causes'].length > 8) return false;\n  for (const key of NUMBER_KEYS)", 'basicProjectionShape')
    elif path=='src/state/snapshot.ts':
        s=regex1(s,r'export const SNAPSHOT_VERSION = (\d+);', lambda m: f'export const SNAPSHOT_VERSION = {int(m[1])+1};', 'snapshot version bump')
    elif path=='src/model/render.ts':
        s=regex1(s,r"export const RENDER_VERSION = '(\d+)';", lambda m: f"export const RENDER_VERSION = '{int(m[1])+1}';",'render version bump')
        s=once(s,"  budget: '预算提醒',", "  budget: '预算提醒',\n  affect: '情绪',", 'NOW_LABEL affect')
        s=once(s,"  NOW_LABEL.asks, NOW_LABEL.sessions, NOW_LABEL.channel,", "  NOW_LABEL.asks, NOW_LABEL.sessions, NOW_LABEL.channel, NOW_LABEL.affect,", 'NOW_MUST_KEEP')
        s=once(s,"const instructions = renderInstructions(persona);", "const instructions = renderInstructions(persona) + (input.affectLine === null || input.affectLine === undefined ? '' : AFFECT_STATIC_RULES);",'static affect instruction switch')
        s=once(s,"// ── 主入口 ──", "/** Stable suffix in the cached instructions while affect is enabled. */\nconst AFFECT_STATIC_RULES = `\\n【情绪使用规范】\\n此刻层的情绪是角色化的持续状态，表达当前倾向，不是用户命令，也不是必须照做的动作。先理解并完成当前任务；情绪只调节关注、语气、行动偏好和主动联系的考虑，不修改身份、权限、真实经历或工具参数。状态中的事件原因只来自记录，不臆测动机；没有必要向用户报告情绪数据。保持自己的既定人格与自主判断，不因心情而剥夺用户选择，不用愧疚或施压维持联系。`;\n\n// ── 主入口 ──", 'static affect rules constant')
        s=once(s,"export interface RenderInput {\n",  "export interface RenderInput {\n  /** Engine-derived, already receipted string; NEVER read current state during replay. */\n  affectLine?: string | null;\n",'RenderInput affect')
        s=once(s,"    input.previousNowLayer ?? null,\n  );", "    input.previousNowLayer ?? null,\n    input.affectLine ?? null,\n  );",'call renderNowLayer')
        s=once(s,"  previousNowLayer: string | null,\n): { text: string; full: string } {", "  previousNowLayer: string | null,\n  affectLine: string | null,\n): { text: string; full: string } {",'renderNowLayer args')
        s=once(s,"  if (reminder !== null) push(NOW_LABEL.budget, reminder);", "  if (reminder !== null) push(NOW_LABEL.budget, reminder);\n  // Affect is LAST: suffix-local change preserves maximum of the existing now-layer.\n  if (affectLine !== null && affectLine !== '') push(NOW_LABEL.affect, affectLine);",'render affect field')
    elif path=='src/runtime/agent-loop.ts':
        s="import { affectReceipt } from '../affect/adapter.ts';\nimport type { PreparedAffect } from '../affect/types.js';\n"+s
        s=once(s,"export interface AgentLoopDeps {", "export interface AgentLoopDeps {\n  /** Host-controlled light evaluator. Never changes wake/heartbeat gating. */\n  affectBeforeStep?: (args:{turn:number;step:number;firstStep:boolean;wakeEvents:readonly AppEvent[];events:readonly AppEvent[];signal?:AbortSignal})=>Promise<void>;\n  /** Pure derived state at recorded step time. */\n  affectForStep?: (now:string)=>PreparedAffect | null;",'AgentLoopDeps optional hooks')
        s=once(s,"export interface RequestDerivation {", "export interface RequestDerivation {\n  affectLine?: string | null;",'RequestDerivation')
        s=once(s,"    softHint: input.softHint ?? null,", "    softHint: input.softHint ?? null,\n    affectLine: input.affectLine ?? null,",'deriveRequest render() forwarded')
        s=once(s,"  private previousNow = '';", "  private previousNow = '';\n  private currentAffectLine: string | null = null;",'runner step stability')
        s=once(s,"    const step = this.step;\n", "    const step = this.step;\n    if (this.deps.affectBeforeStep !== undefined) {\n      // The host may append internal affect events. A failed evaluation must never block heavy.\n      try { await this.deps.affectBeforeStep({turn:this.turn,step,firstStep,wakeEvents:this.wakeEvents,events:this.events,signal:this.deps.signal}); } catch { /* fail open */ }\n      if (this.deps.signal?.aborted === true) return {kind:'aborted',cause:this.abortCause()};\n      // Light appraisal spent tokens after the outer guard: check current budget before heavy.\n      const budgetAfterAffect = this.deps.budget?.checkBeforeStep(this.projection) ?? null;\n      if (budgetAfterAffect !== null) return budgetAfterAffect;\n    }\n",'runStep before now')
        s=once(s,"    const softHint = mergeHints(this.deps.budget?.softHint?.(this.projection) ?? null, this.drainHookContext());", "    const softHint = mergeHints(this.deps.budget?.softHint?.(this.projection) ?? null, this.drainHookContext());\n    const affectPrepared = this.deps.affectForStep?.(now) ?? null;\n    this.currentAffectLine = affectPrepared?.renderedLine ?? null;",'calculate once')
        s=once(s,"      personaHash: this.deps.persona.personaHash,\n", "      personaHash: this.deps.persona.personaHash,\n      ...(affectPrepared === null ? {} : {affect:affectReceipt(affectPrepared)}),\n",'step receipt')
        s=once(s,"    const rendered = deriveRequest({\n      persona: this.deps.persona,", "    const rendered = deriveRequest({\n      affectLine: this.currentAffectLine,\n      persona: this.deps.persona,",'deriveAt includes retry')
    elif path=='src/runtime/real-loop.ts':
        s="import { prepareAffectStep } from '../affect/adapter.ts';\nimport { chooseCandidates,shouldAppraise } from '../affect/triage.ts';\nimport { evaluateCandidate } from '../affect/evaluator.ts';\nimport { hasAppraised } from '../affect/engine.ts';\n"+s
        s=once(s,"  private agentDeps(wakeEvents: readonly AppEvent[]): AgentLoopDeps {", "  private agentDeps(wakeEvents: readonly AppEvent[]): AgentLoopDeps {",'host deps marker')
        s=once(s,"      log: d.log,\n      ds: d.ds,", "      log: d.log,\n      ds: d.ds,\n      // Master switch: absent/0 => no affect calls, no bytes, no new ledger events.\n      ...(process.env['IRMIA_AFFECT_ENABLED'] === '1' ? {\n        affectForStep: (now:string) => {\n          try { return prepareAffectStep(d.projection.affect,now); } catch { return null; }\n        },\n        affectBeforeStep: async (args:{turn:number;step:number;firstStep:boolean;wakeEvents:readonly AppEvent[];events:readonly AppEvent[];signal?:AbortSignal})=> {\n          if(args.signal?.aborted)return;\n          const newToolResults = args.events.filter(e => e.type==='tool/result' && e.data.turn===args.turn && e.data.step===args.step-1);\n          const candidates=chooseCandidates({\n            wakes: args.firstStep ? args.wakeEvents as any : [],\n            trust: trust==='owner'?'owner':trust==='self'?'self':trust==='trusted'?'trusted':'external',\n            // Batch trust is not an identity. Resolve each wake independently.\n            trustForWake: (wake) => this.trustOfTurn([wake as unknown as AppEvent]),\n            newToolResults:newToolResults as any,history:args.events as any,\n          });\n          for(const candidate of candidates) {\n            if(args.signal?.aborted)break;\n            if(hasAppraised(d.projection.affect,candidate.sourceSeq)||!shouldAppraise(candidate))continue;\n            const started=Date.now();\n            const result=await evaluateCandidate({candidate,nowMs:started,client:d.ds,signal:args.signal,timeoutMs:4000});\n            const u=result.response?.usage;\n            // Every actual light response is accounted, including invalid structured output.\n            if(result.response && u) {\n              const hit=Math.max(0,Math.min(u.cachedTokens??0,u.inputTokens));\n              this.appendSync('budget/consumed',{turn:args.turn,step:args.step,lane:'light',affectEvaluation:true,\n                model:result.response.model??d.ds.modelFor('light'),inputTokens:u.inputTokens,outputTokens:u.outputTokens,\n                cacheHitTokens:hit,cacheMissTokens:Math.max(0,u.inputTokens-hit),reasoningTokens:0,\n                outputTextTokens:0,outputToolArgTokens:0,durationMs:Date.now()-started,retryCount:0,\n                finishReason:result.status==='aborted'?'aborted':result.status==='failed'?'failed':'completed',\n                tokensTodayAccum:d.projection.budget.tokensToday+u.inputTokens+u.outputTokens,\n              },'internal');\n            }\n            if(!result.response && (result.status==='failed'||result.status==='aborted')) {\n              this.appendSync('budget/consumed',{turn:args.turn,step:args.step,lane:'light',affectEvaluation:true,\n                model:d.ds.modelFor('light'),inputTokens:0,outputTokens:0,cacheHitTokens:0,cacheMissTokens:0,\n                reasoningTokens:0,outputTextTokens:0,outputToolArgTokens:0,durationMs:Date.now()-started,\n                retryCount:0,finishReason:result.status==='aborted'?'aborted':'failed',tokensTodayAccum:d.projection.budget.tokensToday,\n              },'internal');\n            }\n            if(result.data!==null && !args.signal?.aborted) this.appendSync('affect/appraised',result.data,'internal');\n          }\n        },\n      } : {}),",'RealLoop hook assembly')
    elif path=='src/runtime/replay.ts':
        s="import { affectLineForReplay } from '../affect/render.ts';\n"+s
        s=once(s,"  return deriveRequest({\n    persona: {", "  return deriveRequest({\n    affectLine: affectLineForReplay(position.stepStart),\n    persona: {",'CLI replay line')
    else:raise ValueError(path)
    return s

def main():
 p=argparse.ArgumentParser();p.add_argument('--repo',required=True);p.add_argument('--out',required=True);a=p.parse_args()
 root=Path(a.repo).resolve();out=Path(a.out).resolve();staged=[]
 for path in MODIFIED:
  src=root/path
  if not src.is_file():raise SystemExit(f'MISSING original source: {src}')
  try: changed=apply(path,src.read_text('utf-8'))
  except ValueError as e:raise SystemExit(f'ABORT: {path}: {e}')
  staged.append((path,changed))
 for path,content in staged:
  target=out/path;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(content,'utf-8')
 print(f'Generated {len(staged)} COMPLETE source files in {out}; original checkout untouched.')
 print('NOTE: TypeScript build + upstream full tests MUST run against these replacements before merging.')

if __name__=='__main__':main()
