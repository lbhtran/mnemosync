// Normalized timeline schema shared between backend parser and frontend.
// The frontend must ONLY ever consume these shapes — never raw JSONL.

export interface ProjectInfo {
  id: string;            // encoded directory name, used as opaque API id
  path: string;          // absolute path to the project folder inside ~/.claude
  decodedPath: string;   // best-effort human-readable original project path
  sessionCount: number;
  lastModified: string;  // ISO
}

export interface SessionInfo {
  sessionId: string;
  projectId: string;
  summary: string;
  startedAt: string;     // ISO
  modifiedAt: string;    // ISO
  messageCount: number;
  gitBranch?: string;
  sizeBytes: number;
  hasSubagents: boolean;
}

export interface SubagentInfo {
  agentId: string;
  agentType?: string;
  description?: string;
}

export interface TimelineMeta {
  sessionId: string;
  projectPath: string;
  startedAt: string;
  endedAt?: string;
  model?: string;
  summary?: string;
  gitBranch?: string;
  turnCount: number;
  eventCount: number;
  filesTouched: string[];
  subagents: SubagentInfo[];
  parseWarnings: string[];
}

export interface Timeline {
  meta: TimelineMeta;
  turns: Turn[];
  hasMore: boolean;
}

// One assistant turn = reasoning + the batch of actions it produced.
// Grouped by assistant think→act cycle, not by tool call, so playback
// reads as "here's the plan → watch it execute".
export interface Turn {
  id: string;
  index: number;
  timestamp: string;
  userPrompt?: string;
  reasoning: ReasoningBlock[];
  events: FileEvent[];
  tokenUsage?: { input: number; output: number };
  isCompactionBoundary?: boolean;
}

export interface ReasoningBlock {
  kind: 'thinking' | 'text';
  content: string;
}

interface FileEventBase {
  id: string;
  timestamp: string;
  rawToolName: string;
  isError?: boolean;
  errorMessage?: string;
}

export type FileEvent = FileEventBase &
  (
    | { kind: 'create'; path: string; content: string }
    | {
        kind: 'edit';
        path: string;
        oldStr: string;
        newStr: string;
        replaceAll?: boolean;
        // Full pre-edit file content when the transcript recorded it
        // (toolUseResult.originalFile). Ground truth for reconstruction.
        baseContent?: string;
      }
    | { kind: 'write'; path: string; content: string }
    | { kind: 'delete'; path: string }
    | { kind: 'read'; path: string; content?: string }
    | { kind: 'bash'; command: string; output?: string; mutating: boolean }
    | { kind: 'subagent'; agentId: string; description: string }
    | { kind: 'other'; toolName: string; summary: string }
  );

export type FileEventKind = FileEvent['kind'];
