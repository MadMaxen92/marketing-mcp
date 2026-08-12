import { parseArgs } from 'node:util';
import {
  getMerchantAccountOverview,
  MerchantApiError,
  registerMerchantGcp,
} from './merchant-center.js';

const GCP_PROJECT_ID = 'first-medium-504614-q0';
const MERCHANT_ACCOUNT_ID = '5500122470';
const DEVELOPER_EMAIL = 'max@flow.fast';
const CONFIRMATION = `${GCP_PROJECT_ID}:${MERCHANT_ACCOUNT_ID}:${DEVELOPER_EMAIL}`;

function usage(): string {
  return [
    'One-time Google Merchant API developer registration.',
    '',
    `This command only targets GCP project ${GCP_PROJECT_ID}, Merchant Center ${MERCHANT_ACCOUNT_ID},`,
    `and the existing OAuth connection for ${DEVELOPER_EMAIL}.`,
    '',
    'Run:',
    `  npm run merchant:register-gcp -- --confirm ${CONFIRMATION}`,
    '',
    'The GCP project is determined by the existing Google OAuth client credentials.',
    'No OAuth client or service account is created by this command.',
  ].join('\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      confirm: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });

  if (values.help) {
    console.log(usage());
    return;
  }
  if (values.confirm !== CONFIRMATION) {
    throw new Error(`Explicit confirmation required.\n\n${usage()}`);
  }

  let registration: any;
  try {
    registration = await registerMerchantGcp({
      connectionId: DEVELOPER_EMAIL,
      accountId: MERCHANT_ACCOUNT_ID,
      developerEmail: DEVELOPER_EMAIL,
    });
  } catch (error) {
    if (!(error instanceof MerchantApiError) || error.status !== 409) throw error;
    registration = {
      connection: { email: DEVELOPER_EMAIL },
      accountId: MERCHANT_ACCOUNT_ID,
      alreadyRegistered: true,
      merchantApiResponse: error.responseBody,
    };
  }

  const overview = await getMerchantAccountOverview({
    connectionId: DEVELOPER_EMAIL,
    accountId: MERCHANT_ACCOUNT_ID,
  });

  console.log(JSON.stringify({
    targetGcpProjectId: GCP_PROJECT_ID,
    registration,
    overviewVerified: true,
    overview,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
