import net from 'node:net';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { TelloLink } from './tello-link.mjs';

const INTERNET_HOST = 'example.com';
const INTERNET_PORT = 443;

export async function checkReach({
  internet = () => pcCanReachInternet(),
  aircraft = () => aircraftAnswers(),
} = {}) {
  const [online, linked] = await Promise.all([yes(internet), yes(aircraft)]);
  return { internet: online, aircraft: linked };
}

export function formatReport(report) {
  return `internet: ${report.internet ? 'yes' : 'no'}\naircraft: ${report.aircraft ? 'yes' : 'no'}`;
}

export function pcCanReachInternet({ connect = defaultConnect, timeout = 4000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeout);
    Promise.resolve()
      .then(() => connect({ timeout }))
      .then(() => finish(true), () => finish(false));
  });
}

export function openTls({ host, port, servername = host, timeout }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(net.isIP(host) ? { host, port } : { host, port, servername });
    const fail = (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('timeout')), timeout);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once('error', fail);
  });
}

export async function aircraftAnswers({ link = new TelloLink({ keepAliveMs: 0 }) } = {}) {
  try {
    await link.connect();
    return true;
  } catch {
    return false;
  } finally {
    link.close();
  }
}

function yes(run) {
  return Promise.resolve().then(run).then((value) => value === true, () => false);
}

function defaultConnect({ timeout }) {
  return openTls({ host: INTERNET_HOST, port: INTERNET_PORT, timeout });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await checkReach();
  console.log(formatReport(report));
}
