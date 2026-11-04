import { NO_DRONE_NETWORK, TelloLink } from './tello-link.mjs';

const link = await check(process.argv.slice(2));
process.exitCode = link.code;
link.close();

async function check(argv) {
  let opened;
  try {
    opened = new TelloLink(options(argv));
    const identity = await opened.connect();
    console.log('Linked');
    console.log(`model: ${identity.model}`);
    console.log(`hardware: ${identity.hardware}`);
    console.log(`sdk: ${identity.sdk}`);
    console.log(`sn: ${identity.sn}`);
    console.log(`battery: ${identity.battery}%`);
    await waitForStates(opened, 3, 3000);
    if (!opened.recentStates.length) {
      console.error(`No state packets. Identity was read, but nothing arrived on UDP ${opened.statePort}. Allow inbound UDP from the aircraft.`);
      return { code: 1, close: () => opened.close() };
    }
    console.log('state:');
    for (const state of opened.recentStates) {
      console.log(`  h=${state.h ?? '?'} bat=${state.bat ?? '?'} yaw=${state.yaw ?? '?'}`);
    }
    return { code: 0, close: () => opened.close() };
  } catch (error) {
    console.error(error.message === NO_DRONE_NETWORK ? NO_DRONE_NETWORK : error.message);
    return { code: 1, close: () => opened?.close() };
  }
}

function options(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--host') parsed.host = value(argv, index, flag);
    else if (flag === '--local') parsed.localAddress = value(argv, index, flag);
    else throw new Error(`Unknown argument: ${flag}`);
    index += 1;
  }
  return parsed;
}

function value(argv, index, flag) {
  const next = argv[index + 1];
  if (!next || next.startsWith('--')) throw new Error(`Missing value for ${flag}`);
  return next;
}

function waitForStates(link, count, timeout) {
  if (link.recentStates.length >= count) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      link.off('state', onState);
      resolve();
    };
    const onState = () => {
      if (link.recentStates.length >= count) finish();
    };
    const timer = setTimeout(finish, timeout);
    link.on('state', onState);
  });
}
