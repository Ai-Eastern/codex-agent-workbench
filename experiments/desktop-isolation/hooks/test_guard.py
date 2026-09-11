import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('guard', Path(__file__).with_name('guard.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class ReadBoundaryTests(unittest.TestCase):
    policy = {'mode': 'enforce', 'hostId': 'host-a', 'allowedThreadIds': ['task-a']}

    def event(self, target, **args):
        return {'tool_name': 'codex_app.read_thread', 'tool_input': {'threadId': target, **args}}

    def test_owned_target_explicit_or_omitted_host(self):
        for args in ({}, {'hostId': 'host-a'}):
            self.assertEqual(guard.decide(self.event('task-a', **args), self.policy)[0], 'allow')

    def test_foreign_target_explicit_or_omitted_host(self):
        for args in ({}, {'hostId': 'host-a'}, {'hostId': 'host-b'}):
            self.assertEqual(guard.decide(self.event('task-b', **args), self.policy)[0], 'deny')

    def test_owned_id_does_not_authorize_foreign_host(self):
        self.assertEqual(guard.decide(self.event('task-a', hostId='host-b'), self.policy)[0], 'deny')

    def test_invalid_policy_and_arguments_deny(self):
        for policy in (None, {}, {'mode': 'enforce', 'hostId': 'host-a', 'allowedThreadIds': [None]}):
            self.assertEqual(guard.decide(self.event('task-a'), policy)[0], 'deny')
        self.assertEqual(guard.decide({'tool_name': 'read_thread', 'tool_input': []}, self.policy)[0], 'deny')

    def test_ordinary_command_is_outside_this_targeted_probe(self):
        self.assertEqual(guard.decide({'tool_name': 'Bash', 'tool_input': {}}, self.policy), ('allow', 'WB_OUTSIDE_SCOPED_READ_TEST'))


if __name__ == '__main__':
    unittest.main()
