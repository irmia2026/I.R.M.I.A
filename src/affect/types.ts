/** Affect is simulated character state, not a claim about subjective experience. */
export const AFFECT_VERSION = 1 as const;       // archived event formula version
export const AFFECT_STATE_VERSION = 3 as const; // derived projection shape
export const EMOTIONS = ['joy','distress','concern','irritation','warmth','shyness'] as const;
export type EmotionName = typeof EMOTIONS[number];
export type EmotionVector = Record<EmotionName,number>;
export const REASONS = [
  'owner_setback','owner_success','friendly_contact','unfriendly_contact',
  'task_success','task_failure','new_discovery','unwelcome_advance','general',
] as const;
export type ReasonCode = typeof REASONS[number];
export interface AffectAppraisal { r:number;s:number;u:number;g:number;b:number;n:number;z:number;c:number;q:number }
export interface AffectCause { sourceSeq:number;reasonCode:ReasonCode;dominantEmotion:EmotionName;strength:number;evaluatedAtMs:number }
/** Lossless 1024-seq buckets; sparse offsets switch to dense fixed 128-byte bitmap. */
export interface EvaluatedChunk { bucket:number; sparse?:number[]; dense?:string }
export interface EvaluatedIndex { version:1; chunks:EvaluatedChunk[] }
export interface AffectState { version:typeof AFFECT_STATE_VERSION;atMs:number;mood:{valence:number;arousal:number};emotions:EmotionVector;evaluated:EvaluatedIndex;causes:AffectCause[] }
/** Immutable event payload: stored impulse, not future formula, is the ledger truth. */
export interface AffectAppraisedData { version:number;sourceSeq:number;evaluatedAtMs:number;sourceWeight:number;appraisal:AffectAppraisal;impulse:EmotionVector;reasonCode:string }
export interface PreparedAffect { state:AffectState;renderedLine:string }
/** Optional step/start.data receipt; makes historical prompt suffix independent of current formulas. */
export interface AffectStepReceipt { version:number;atMs:number;renderedLine:string }
