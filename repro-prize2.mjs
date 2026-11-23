import { startServer, makeClient, login, unlock, resetSchema } from './test/helpers.mjs';

const DB = 'postgres://postgres:postgres@127.0.0.1:55440/oddeven_debug';

await resetSchema(DB);
const server = await startServer({ databaseUrl: DB });
const api = makeClient(server.base);

const admin = await login(api);
const token = admin.token;

// 场景 A：先配规则，再建新场次
const prizes = {
  both: { title: {'zh-CN':'特等奖','zh-HK':'特等獎','en-US':'Grand'}, desc: {'zh-CN':'都中','zh-HK':'都中','en-US':'both'} },
  number: { title: {'zh-CN':'一等奖','zh-HK':'一等獎','en-US':'First'}, desc: {'zh-CN':'','zh-HK':'','en-US':''} },
  oddeven: { title: {'zh-CN':'二等奖','zh-HK':'二等獎','en-US':'Second'}, desc: {'zh-CN':'','zh-HK':'','en-US':''} },
  miss: { title: {'zh-CN':'谢谢','zh-HK':'謝謝','en-US':'Thanks'}, desc: {'zh-CN':'','zh-HK':'','en-US':''} },
};
await api.post('/api/prize-config', { token, prizes });

// 建新场次
const created = await api.post('/api/session-create', { token, name: '新场次' });
console.log('CREATE', created.status, JSON.stringify(created.body));
const sid = created.body.sid;

const un = await unlock(api, sid, 'test-player-pw');
const ut = un.body.ut;
const scan = await api.post('/api/scan', { sid, ut, content: 'MEMBER-0001' });
const pid = scan.body.pid;

const st = await api.get('/api/state?sid=' + encodeURIComponent(sid) + '&ut=' + encodeURIComponent(ut) + '&pid=' + encodeURIComponent(pid));
console.log('NEW SESSION ruleVersion', st.body.ruleVersion);
console.log('NEW SESSION prizes.both.title =', JSON.stringify(st.body.prizes.both.title));

await server.stop();
