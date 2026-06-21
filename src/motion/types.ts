import type { ConsultantBriefing } from '../boardroom/consultant.js';

export interface SecondVote {
  panelist: string;
  role: string;
  model: string;
  seconded: boolean;
  reason: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error?: string;
}

export type Stance = 'SUPPORT' | 'OPPOSE' | 'UNDECIDED';

export interface DebateSpeech {
  panelist: string;
  role: string;
  model: string;
  stance: Stance;
  case: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error?: string;
}

export type Vote = 'AYE' | 'NAY' | 'ABSTAIN';

export interface FinalVote {
  panelist: string;
  role: string;
  model: string;
  vote: Vote;
  reason: string;
  flipped: boolean;             // true if vote disagrees with debate stance
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error?: string;
}

export type Outcome =
  | 'passed'
  | 'failed'
  | 'tied'
  | 'died_for_lack_of_second';

export interface MotionResult {
  id: string;                   // ISO timestamp YYYY-MM-DD-HHMM
  motion: string;
  mover: string;                // "the founder"
  startedAt: string;            // ISO timestamp
  briefing: ConsultantBriefing | null;
  seconds: SecondVote[];
  debate: DebateSpeech[];
  votes: FinalVote[];
  tally: { aye: number; nay: number; abstain: number };
  outcome: Outcome;
  minutesPath?: string;
}
