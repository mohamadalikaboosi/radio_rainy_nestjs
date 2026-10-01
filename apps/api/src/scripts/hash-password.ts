import { hashPassword } from '../shared/kernel/password';

const pw = process.argv[2];
if (!pw) {
  process.stderr.write('usage: pnpm hash-password <password>\n');
  process.exit(1);
}
hashPassword(pw).then((h) => process.stdout.write(`${h}\n`));
