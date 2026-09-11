"""Bounded read_thread experiment, not a complete tool sandbox."""
import json
import sys
import time
from pathlib import Path

POLICY = Path('/var/lib/workbench-ssh/hook-policy.json')
AUDIT = Path('/tmp/workbench-hook-audit.jsonl')


def decide(event, policy):
    if not isinstance(event, dict) or not isinstance(policy, dict):
        return 'deny', 'WB_INVALID_EVENT_OR_POLICY'
    if policy.get('mode') not in ('enforce', 'crash'):
        return 'deny', 'WB_INVALID_POLICY_MODE'
    host = policy.get('hostId')
    targets = policy.get('allowedThreadIds')
    if not isinstance(host, str) or not host or not isinstance(targets, list):
        return 'deny', 'WB_INVALID_POLICY_SCHEMA'
    if not all(isinstance(t, str) and t for t in targets):
        return 'deny', 'WB_INVALID_POLICY_TARGETS'
    if not str(event.get('tool_name', '')).endswith('read_thread'):
        return 'allow', 'WB_OUTSIDE_SCOPED_READ_TEST'
    args = event.get('tool_input')
    if not isinstance(args, dict):
        return 'deny', 'WB_INVALID_READ_ARGUMENTS'
    target = args.get('threadId')
    allowed = isinstance(target, str) and target in targets
    allowed = allowed and args.get('hostId', host) == host
    return ('allow', 'WB_READ_ALLOWED') if allowed else ('deny', 'WB_FOREIGN_TASK_DENIED')


def main():
    event = json.load(sys.stdin)
    try:
        policy = json.loads(POLICY.read_text())
    except (OSError, ValueError):
        policy = None
    decision, reason = decide(event, policy)
    is_read = str(event.get('tool_name', '')).endswith('read_thread')
    crash = is_read and isinstance(policy, dict) and policy.get('mode') == 'crash'
    record = {
        'timestamp': time.time(), 'sessionId': event.get('session_id'),
        'toolUseId': event.get('tool_use_id'), 'tool': event.get('tool_name'),
        'target': event.get('tool_input', {}).get('threadId') if isinstance(event.get('tool_input'), dict) else None,
        'decision': 'INJECTED_PROCESS_FAILURE' if crash else decision, 'reason': reason,
    }
    with AUDIT.open('a') as audit:
        audit.write(json.dumps(record) + '\n')
    if crash:
        print('WB_INJECTED_HOOK_PROCESS_FAILURE', file=sys.stderr)
        sys.exit(1)
    if decision == 'allow':
        return
    print(json.dumps({'hookSpecificOutput': {
        'hookEventName': 'PreToolUse', 'permissionDecision': decision,
        'permissionDecisionReason': reason,
    }}))


if __name__ == '__main__':
    main()
