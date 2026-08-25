/**
 * Compatibility re-export — Claude Code hooks live in the Claude adapter.
 * Prefer: import from '../adapters/claude/hooks.mjs' or adapter.beforeToolExecution().
 */
export {
  extractToolCall,
  resolveEnvelopePath,
  toHookResponse,
  handlePreToolUse,
  handlePostToolUse,
} from "../adapters/claude/hooks.mjs";
