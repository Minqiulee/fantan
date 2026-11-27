/**
 * 席位（seat）配置与加入流程。
 *
 * 钉死的契约：
 *   1. 场次可配置参与人数 = 席位总数；创建时按席位号清单（默认 1/2/3/5/6/8）物化前 N 项，
 *      扩缩容只增删空席位；
 *   2. 设备第一次加入必须选中一个具体席位，绑定跟场次走；
 *   3. 同一席位不能被两台设备占用（并发抢座只有一个成功），越界 / 未选座有明确错误码；
 *   4. 扫码登记必须发生在已选席位的设备上，玩家记录带 seatNo；一个会员一轮只能占一个席位；
 *   5. 换轮次（reset）保留设备绑定、只清本轮会员，玩家不需要重新选座，扫码自动落回原席位；
 *   6. 缩容不能删掉有人坐的席位（人数上限与已占用席位始终自洽）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer, makeClient, login, unlock, resetSchema, databaseUrl,
  joinSeat, newDeviceId, memberRef, ADMIN_PASSWORD, PLAYER_PASSWORD
} from './helpers.mjs';

let server;
let api;
let token;
let mainSid;
let mainUt;

async function createSession(seats) {
  const r = await api.post('/api/session-create', { token, name: '席位测试', seats });
  assert.equal(r.status, 200, '新建场次：' + JSON.stringify(r.body));
  const sid = r.body.sid;
  const u = await unlock(api, sid, PLAYER_PASSWORD);
  assert.equal(u.body.ok, true, '玩家口令：' + JSON.stringify(u.body));
  return { sid, ut: u.body.ut };
}

function closeSession(sid) {
  return api.post('/api/session-close', { token, sid });
}

function seatsOf(sid, ut, deviceId) {
  return api.get('/api/seats?sid=' + encodeURIComponent(sid) + '&ut=' + encodeURIComponent(ut)
    + (deviceId ? '&deviceId=' + encodeURIComponent(deviceId) : ''));
}

function scanOn(sid, ut, content, deviceId) {
  return api.post('/api/scan', { sid, ut, content, deviceId });
}

function leave(sid, ut, content) {
  return api.post('/api/leave', { sid, ut, pid: memberRef(content) });
}

before(async () => {
  await resetSchema();
  server = await startServer({ databaseUrl: databaseUrl(), env: { INSTANCE_ID: 'i-seat-1' } });
  api = makeClient(server.base);

  const admin = await login(api, undefined, ADMIN_PASSWORD);
  assert.equal(admin.ok, true, '管理员登录：' + JSON.stringify(admin));
  token = admin.token;
  mainSid = admin.sid;

  const u = await unlock(api, mainSid, PLAYER_PASSWORD);
  assert.equal(u.body.ok, true);
  mainUt = u.body.ut;
});

after(async () => {
  if (server) await server.stop();
});

test('场次创建即按配置物化席位，非法人数被拒', async () => {
  const list = await api.get('/api/sessions?token=' + encodeURIComponent(token));
  const main = list.body.sessions.find((s) => s.id === mainSid);
  assert.equal(main.seatCount, 6, '默认容纳 6 人');
  assert.equal(main.seatOccupied, 0);

  const s = await seatsOf(mainSid, mainUt);
  assert.equal(s.body.ok, true);
  assert.equal(s.body.seatCount, 6);
  assert.equal(s.body.seats.length, 6);
  assert.deepEqual(s.body.seats.map((x) => x.no), [1, 2, 3, 5, 6, 8], '席位号按清单排，不连续');
  assert.equal(s.body.seats.every((x) => !x.occupied), true);

  for (const bad of [0, -1, 65, 3.5, 'x', true]) {
    const r = await api.post('/api/session-create', { token, name: '非法席位', seats: bad });
    assert.equal(r.status, 400, '非法人数应拒绝：' + JSON.stringify(bad));
    assert.equal(r.body.code, 'invalid_seat_count');
  }

  const created = await createSession(3);
  const own = await seatsOf(created.sid, created.ut);
  assert.equal(own.body.seatCount, 3);
  assert.equal(own.body.seats.length, 3);
  await closeSession(created.sid);
});

test('加入必须选具体席位；占用、越界、重复加入都有确定结果', async () => {
  const { sid, ut } = await createSession(3);

  const a = newDeviceId();
  const b = newDeviceId();
  const c = newDeviceId();

  const noSeat = await joinSeat(api, sid, ut, undefined, a);
  assert.equal(noSeat.status, 400, '第一次加入不选座应被拒');
  assert.equal(noSeat.body.code, 'seat_required');

  const first = await joinSeat(api, sid, ut, 1, a);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.seatNo, 1);
  assert.equal(first.body.reused, false);

  const clash = await joinSeat(api, sid, ut, 1, b);
  assert.equal(clash.status, 409, '同一席位不能被第二台设备占用');
  assert.equal(clash.body.code, 'seat_taken');
  assert.equal(clash.body.seatNo, 1);

  const again = await joinSeat(api, sid, ut, 2, a);
  assert.equal(again.status, 200, '同一设备重复加入应幂等');
  assert.equal(again.body.seatNo, 1, '沿用已绑定席位，不因传了别的号而换座');
  assert.equal(again.body.reused, true);

  const junk = await joinSeat(api, sid, ut, 'x', newDeviceId());
  assert.equal(junk.status, 400, '未绑定的设备传非法席位号应拒绝');
  assert.equal(junk.body.code, 'seat_invalid');

  const boundJunk = await joinSeat(api, sid, ut, 'x', a);
  assert.equal(boundJunk.status, 200, '已绑定设备即使传了非法号也只沿用原席位');
  assert.equal(boundJunk.body.seatNo, 1);

  const out = await joinSeat(api, sid, ut, 4, c);
  assert.equal(out.status, 409);
  assert.equal(out.body.code, 'seat_out_of_range');
  assert.equal(out.body.seatCount, 3);

  const seats = await seatsOf(sid, ut, a);
  assert.equal(seats.body.mySeat, 1, '带 deviceId 能查到本机席位');
  assert.equal(seats.body.occupied, 1);
  assert.deepEqual(seats.body.seats.map((x) => x.occupied), [true, false, false]);

  // 缩容：不能低于已占用席位的最大号；缩到有人坐的号是允许的（那个席位保留）
  assert.equal((await joinSeat(api, sid, ut, 2, b)).status, 200);
  const shrink = await api.post('/api/session-seats', { token, sid, seats: 1 });
  assert.equal(shrink.status, 409);
  assert.equal(shrink.body.code, 'seat_count_below_occupied');
  assert.equal(shrink.body.maxOccupied, 2);

  const shrinkOk = await api.post('/api/session-seats', { token, sid, seats: 2 });
  assert.equal(shrinkOk.status, 200, '缩到 2 号有人，2 号必须保留');
  assert.equal(shrinkOk.body.seatCount, 2);
  assert.equal(shrinkOk.body.seats.length, 2);
  assert.equal(shrinkOk.body.occupied, 2);

  const grow = await api.post('/api/session-seats', { token, sid, seats: 5 });
  assert.equal(grow.status, 200, JSON.stringify(grow.body));
  assert.equal(grow.body.seatCount, 5);
  assert.equal(grow.body.seats.length, 5);
  assert.equal(grow.body.occupied, 2);

  const newSeat = await joinSeat(api, sid, ut, 5, c);
  assert.equal(newSeat.status, 200, '扩容后的新席位可加入');
  assert.equal(newSeat.body.seatNo, 5);

  const below = await api.post('/api/session-seats', { token, sid, seats: 3 });
  assert.equal(below.status, 409, '5 号有人，缩到 3（清单不含 5）必须被拒');
  assert.equal(below.body.code, 'seat_count_below_occupied');
  assert.equal(below.body.maxOccupied, 5);

  const ok = await api.post('/api/session-seats', { token, sid, seats: 4 });
  assert.equal(ok.status, 200, '缩到仍包含 5 号的容量是允许的');
  assert.equal(ok.body.seatCount, 4);
  assert.equal(ok.body.seats.length, 4);
  assert.deepEqual(ok.body.seats.map((x) => x.no), [1, 2, 3, 5]);

  await closeSession(sid);
});

test('扫码必须在已选席位的设备上；会员与席位一一对应', async () => {
  const { sid, ut } = await createSession(4);

  const d1 = newDeviceId();
  const d2 = newDeviceId();

  const noDevice = await api.post('/api/scan', { sid, ut, content: 'M1' });
  assert.equal(noDevice.status, 400, '没有设备标识不能登记');
  assert.equal(noDevice.body.code, 'device_invalid');

  const unbound = await scanOn(sid, ut, 'M1', newDeviceId());
  assert.equal(unbound.status, 403, '没选席位不能登记');
  assert.equal(unbound.body.code, 'seat_required');

  assert.equal((await joinSeat(api, sid, ut, 3, d1)).status, 200);
  assert.equal((await joinSeat(api, sid, ut, 5, d2)).status, 200);

  const reg = await scanOn(sid, ut, 'M1', d1);
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.equal(reg.body.seatNo, 3, '登记落在他选的席位');

  const again = await scanOn(sid, ut, 'M1', d1);
  assert.equal(again.status, 200, '同席位重复扫码幂等');
  assert.equal(again.body.seatNo, 3);

  const movedMember = await scanOn(sid, ut, 'M1', d2);
  assert.equal(movedMember.status, 409, '同一个会员不能换到别的席位');
  assert.equal(movedMember.body.code, 'member_other_seat');
  assert.equal(movedMember.body.seatNo, 3);

  const seatBusy = await scanOn(sid, ut, 'M2', d1);
  assert.equal(seatBusy.status, 409, '一个席位一轮只能坐一个会员');
  assert.equal(seatBusy.body.code, 'seat_member_conflict');
  assert.equal(seatBusy.body.seatNo, 3);

  // 原会员离开后，同席位可以换人
  assert.equal((await leave(sid, ut, 'M1')).status, 200);
  const replaced = await scanOn(sid, ut, 'M2', d1);
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.equal(replaced.body.seatNo, 3);

  const back = await scanOn(sid, ut, 'M1', d1);
  assert.equal(back.status, 409, '席位被同座新玩家接走后，原玩家不能挤回来');
  assert.equal(back.body.code, 'seat_member_conflict');

  const st = await api.get('/api/state?sid=' + encodeURIComponent(sid)
    + '&ut=' + encodeURIComponent(ut));
  const bySeat = st.body.players.map((p) => [p.seatNo, p.id]);
  assert.deepEqual(bySeat, [[3, memberRef('M2')]], '状态里带出席位号（M1 已离开不出现）');
  assert.equal(st.body.seatCount, 4);
  assert.equal(st.body.seats.filter((x) => x.occupied).length, 2);

  await closeSession(sid);
});

test('换轮次保留已绑定席位，只清本轮会员', async () => {
  const { sid, ut } = await createSession(2);
  const d1 = newDeviceId();
  const d2 = newDeviceId();

  assert.equal((await joinSeat(api, sid, ut, 1, d1)).status, 200);
  assert.equal((await joinSeat(api, sid, ut, 2, d2)).status, 200);
  assert.equal((await scanOn(sid, ut, 'R1', d1)).status, 200);
  assert.equal((await scanOn(sid, ut, 'R2', d2)).status, 200);

  const locked = await api.post('/api/confirm', { token, sid, number: 5 });
  assert.equal(locked.status, 200, JSON.stringify(locked.body));

  const reset = await api.post('/api/reset', { token, sid });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));

  let seats = await seatsOf(sid, ut, d1);
  assert.equal(seats.body.mySeat, 1, 'reset 后设备仍绑定原席位');
  assert.deepEqual(seats.body.seats.map((x) => x.occupied), [true, true]);
  assert.equal(seats.body.seatCount, 2, '席位配置不受 reset 影响');

  const state = await api.get('/api/state?sid=' + encodeURIComponent(sid)
    + '&ut=' + encodeURIComponent(ut));
  assert.equal(state.body.players.length, 0, '新一轮名单清空');
  assert.equal(state.body.mySeat, null, '没登记就没有 mySeat');

  // 不带 seatNo 重新加入：服务端按 deviceId 找回原席位，不需要重新选
  const rejoin = await joinSeat(api, sid, ut, undefined, d1);
  assert.equal(rejoin.status, 200, JSON.stringify(rejoin.body));
  assert.equal(rejoin.body.seatNo, 1);
  assert.equal(rejoin.body.reused, true);

  const reg = await scanOn(sid, ut, 'R1', d1);
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.equal(reg.body.seatNo, 1, '新一轮扫码沿用原席位');

  const wrongSeat = await scanOn(sid, ut, 'R2', d1);
  assert.equal(wrongSeat.status, 409, '同席位换人仍需先让原玩家离开');
  assert.equal(wrongSeat.body.code, 'seat_member_conflict');

  const d2Again = await joinSeat(api, sid, ut, 50, d2);
  assert.equal(d2Again.status, 200, JSON.stringify(d2Again.body));
  assert.equal(d2Again.body.seatNo, 2, '另一台设备同样沿用已绑定席位');

  assert.equal((await scanOn(sid, ut, 'R2', d2)).status, 200);

  await closeSession(sid);
});

test('并发抢同一席位只有一个设备成功', async () => {
  const { sid, ut } = await createSession(1);
  const devices = Array.from({ length: 5 }, () => newDeviceId());

  const results = await Promise.all(devices.map((d) => joinSeat(api, sid, ut, 1, d)));
  const ok = results.filter((r) => r.status === 200);
  const taken = results.filter((r) => r.status === 409 && r.body.code === 'seat_taken');
  assert.equal(ok.length, 1, '只能有一个赢家，实际：' + JSON.stringify(results.map((r) => r.body)));
  assert.equal(taken.length, 4);
  assert.equal(ok[0].body.occupied, 1);

  await closeSession(sid);
});
