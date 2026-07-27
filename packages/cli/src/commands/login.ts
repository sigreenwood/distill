import * as readline from 'readline';
import { PlaudConfig, PlaudAuth } from '@plaud/core';

export async function loginCommand(_args: string[]): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise(resolve => rl.question(q, resolve));

  // Same as ask(), but masks the typed characters so the password
  // isn't echoed to the terminal (or captured in terminal scrollback).
  const askHidden = (q: string): Promise<string> =>
    new Promise(resolve => {
      const anyRl = rl as any;
      anyRl.question(q, (answer: string) => {
        anyRl._muted = false;
        process.stdout.write('\n');
        resolve(answer);
      });
      anyRl._muted = true;
      anyRl._writeToOutput = function (this: any, str: string) {
        if (this._muted) {
          // Still show the prompt itself, just not the typed characters
          if (str.includes(q)) this.output.write(q);
        } else {
          this.output.write(str);
        }
      };
    });

  try {
    const email = await ask('Plaud email: ');
    const password = await askHidden('Password: ');
    const regionInput = await ask('Region (us/eu) [eu]: ');
    const region = (regionInput.trim() || 'eu') as 'us' | 'eu';

    const config = new PlaudConfig();
    config.saveCredentials({ email: email.trim(), password, region });

    console.log('Credentials saved. Verifying...');

    const auth = new PlaudAuth(config);
    const token = await auth.login();
    console.log(`Login successful! Token valid for ~300 days.`);
  } finally {
    rl.close();
  }
}
