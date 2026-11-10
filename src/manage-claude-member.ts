import { readFile } from 'node:fs/promises';
import { provisionMember, revokeMember } from './claude-members.js';

const [command, email, extra] = process.argv.slice(2);

try {
  if (!email || extra || (command !== 'set' && command !== 'revoke')) {
    throw new Error('Usage: node dist/manage-claude-member.js set EMAIL < grants.json | revoke EMAIL');
  }
  if (command === 'set') {
    const grants = JSON.parse(await readFile('/dev/stdin', 'utf8'));
    const member = await provisionMember(email, grants);
    console.log(JSON.stringify(member, null, 2));
  } else {
    await revokeMember(email);
    console.log('Claude member access revoked.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Member update failed.');
  process.exitCode = 1;
}
