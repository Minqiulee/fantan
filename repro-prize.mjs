import { startServer, makeClient, login, unlock, resetSchema } from './test/helpers.mjs';

const DB = 'postgres://postgres:postgres@127.0.0.1:55440/oddeven_debug';

await resetSchema(DB);
const server = await startServer({ databaseUrl: DB });
const api = makeClient(server.base);

const admin = await login(api);
const token = admin.token;
let sid = admin.sid;

const prizes = {
  both: { title: {'zh-CN':'特等奖','zh-HK':'特等獎','en-US':'Grand'}, desc: {'zh-CN':'都中','zh-HK':'都中','en-US':'both'} },
  number: { title: {'zh-CN':'一等奖','zh-HK':'一等獎','en-US':'First'}, desc: {'zh-CN':'','zh-HK':'','en-US':''} },
  oddeven: { title: {'zh-CN':'二等奖','zh-HK':'二等獎','en-US':'Second'}, desc: {'zh-CN':'','zh-HK':'','en-US':''} },
  miss: { title: {'zh-CN':'谢谢','zh-HK':'謝謝','en-US':'Thanks'}, desc: {'zh-CN':'','zh-HK':'','en-US':''} },
};
const save = await api.post('/api/prize-config', { token, prizes });
console.log('SAVE status', save.status, 'ruleVersion', save.body.ruleVersion, 'created', save.body.created);
console.log('SAVE prizes.both.title =', JSON.stringify(save.body.prizes.both.title));

const un = await unlock(api, sid, 'test-player-pw');
const ut = un.body.ut;
const scan = await api.post('/api/scan', { sid, ut, content: 'MEMBER-0001' });
console.log('SCAN', scan.status, JSON.stringify(scan.body));
const pid = scan.body.pid || scan.body.playerId;

const st = await api.get('/api/state?sid=' + encodeURIComponent(sid) + '&ut=' + encodeURIComponent(ut) + '&pid=' + encodeURIComponent(pid));
console.log('STATE ruleVersion', st.body.ruleVersion);
console.log('STATE prizes =', JSON.stringify(st.body.prizes));

await server.stop();
