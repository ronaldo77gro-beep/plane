// Разделы для крупье и администраторов
import {
  sb, state, isAdmin, q, esc, money, num, pts, fmtDate, fmtTime, fmtDateTime, statusBadge, roleBadge, placeHtml,
  playerName, REG_LABEL, ROLE_LABEL, toast, toastErr, confirmDialog, openModal, closeModal, busy, $, $$, formData,
} from './core.js';
import { reload } from './app.js';

const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

// ---------------------------------------------------------------- ADMIN HOME
export async function pageAdmin({ render, args, params }) {
  const tab = args[0] === 'users' ? 'users' : 'tournaments';
  render(`<div class="loader">Загрузка…</div>`);
  const head = `
    <div class="page-head"><h1>Управление клубом</h1>
      <div class="btn-row"><a class="btn primary" href="#/edit/new">+ Новый турнир</a><a class="btn" href="timer.html" target="_blank" rel="noopener">Таймер блайндов</a></div></div>
    <div class="tabs"><a href="#/admin" class="${tab === 'tournaments' ? 'active' : ''}">Турниры</a><a href="#/admin/users" class="${tab === 'users' ? 'active' : ''}">Игроки</a></div>`;

  if (tab === 'tournaments') {
    const list = await q(sb.from('tournaments_view').select('*').order('starts_at', { ascending: false }).limit(200));
    const active = list.filter(t => ['scheduled', 'running'].includes(t.status)).reverse();
    const past = list.filter(t => !['scheduled', 'running'].includes(t.status));
    const row = (t) => `<tr>
      <td class="small" style="white-space:nowrap">${fmtDate(t.starts_at)}<br><span class="muted">${fmtTime(t.starts_at)}</span></td>
      <td><a href="#/t/${t.id}"><b>${esc(t.title)}</b></a><div class="muted small">${esc(t.location || '')}</div></td>
      <td>${statusBadge(t)}</td>
      <td class="num">${t.seats_taken}/${t.max_players}${t.waitlist_count ? `<div class="muted small">+${t.waitlist_count} ждут</div>` : ''}</td>
      <td><div class="btn-row" style="gap:6px; flex-wrap:nowrap">
        <a class="btn sm primary" href="#/manage/${t.id}">Управлять</a>
        <a class="btn sm" href="#/edit/${t.id}">Изменить</a>
        <a class="btn sm" href="#/edit/new?copy=${t.id}" title="Создать такой же турнир через неделю">Копия</a>
        ${isAdmin() ? `<button class="btn sm danger" data-del="${t.id}" data-title="${esc(t.title)}">Удалить</button>` : ''}
      </div></td></tr>`;
    const table = (rows) => rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Дата</th><th>Турнир</th><th>Статус</th><th class="num">Места</th><th></th></tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div>` : `<div class="card empty">Нет турниров</div>`;
    render(`${head}
      <h2>Активные и предстоящие</h2>${table(active)}
      <div class="section"><h2>Прошедшие</h2>${table(past)}</div>`);
    $$('[data-del]').forEach(b => b.onclick = async () => {
      if (!await confirmDialog('Удалить турнир?', `«${b.dataset.title}» и все записи и результаты будут удалены безвозвратно.`, 'Удалить', true)) return;
      busy(b, async () => { await q(sb.from('tournaments').delete().eq('id', b.dataset.del)); toast('Турнир удалён'); reload(); });
    });
    return;
  }

  // ---- игроки
  const search = (params.get('q') || '').trim();
  let qb = sb.from('profiles').select('*, profile_contacts(email,phone,telegram)').order('created_at', { ascending: false }).limit(300);
  if (search) qb = qb.ilike('nickname', `%${search.replace(/[%_\\]/g, '\\$&')}%`);
  const users = await q(qb);
  render(`${head}
    <form id="searchForm" class="btn-row" style="margin-bottom:16px"><input name="q" placeholder="Поиск по нику" value="${esc(search)}" style="max-width:280px"><button class="btn" type="submit">Найти</button></form>
    ${!isAdmin() ? `<div class="notice" style="margin-bottom:14px">Менять роли и блокировать игроков может только администратор.</div>` : ''}
    <div class="table-wrap"><table class="tbl"><thead><tr><th>Игрок</th><th>Контакты</th><th>Роль</th><th>Статус</th><th>С нами</th></tr></thead><tbody>
    ${users.map(u => {
      const c = u.profile_contacts || {};
      const self = u.id === state.user.id;
      return `<tr>
        <td><a href="#/player/${u.id}"><b>${esc(u.nickname)}</b></a><div class="muted small">${esc(u.full_name || '')}</div></td>
        <td class="small">${esc(c.email || '')}${c.phone ? `<br>${esc(c.phone)}` : ''}${c.telegram ? `<br>${esc(c.telegram)}` : ''}</td>
        <td>${isAdmin() && !self ? `<select data-role="${u.id}">${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select>` : roleBadge(u.role)}</td>
        <td>${isAdmin() && !self ? `<button class="btn sm ${u.is_banned ? 'success' : 'danger'}" data-ban="${u.id}" data-v="${u.is_banned ? 0 : 1}">${u.is_banned ? 'Разблокировать' : 'Заблокировать'}</button>` : (u.is_banned ? '<span class="badge banned">Заблокирован</span>' : '<span class="muted small">активен</span>')}</td>
        <td class="small muted" style="white-space:nowrap">${fmtDate(u.created_at)}</td></tr>`;
    }).join('') || `<tr><td colspan="5" class="empty">Никого не найдено</td></tr>`}
    </tbody></table></div>`);
  $('#searchForm').onsubmit = (e) => { e.preventDefault(); const v = formData(e.target).q.trim(); location.hash = '#/admin/users' + (v ? '?q=' + encodeURIComponent(v) : ''); };
  $$('[data-role]').forEach(s => s.onchange = () => busy(null, async () => {
    await q(sb.from('profiles').update({ role: s.value }).eq('id', s.dataset.role));
    toast('Роль изменена: ' + ROLE_LABEL[s.value], 'ok');
  }));
  $$('[data-ban]').forEach(b => b.onclick = () => busy(b, async () => {
    await q(sb.from('profiles').update({ is_banned: b.dataset.v === '1' }).eq('id', b.dataset.ban));
    toast(b.dataset.v === '1' ? 'Игрок заблокирован' : 'Игрок разблокирован');
    reload();
  }));
}

// ---------------------------------------------------------------- CREATE / EDIT TOURNAMENT
export async function pageEditTournament({ render, args: [id], params }) {
  const isNew = id === 'new';
  render(`<div class="loader">Загрузка…</div>`);
  let t = { title: '', description: '', location: '', buy_in: 0, rebuy_price: 0, addon_price: 0, starting_stack: 10000, max_players: 27, seats_per_table: 9, is_rating: true, points_multiplier: 1, registration_open: true, status: 'scheduled' };
  let starts = new Date(); starts.setDate(starts.getDate() + 1); starts.setHours(19, 0, 0, 0);
  const srcId = isNew ? params.get('copy') : id;
  if (srcId) {
    const src = await q(sb.from('tournaments').select('*').eq('id', srcId).maybeSingle());
    if (!src) { render(`<div class="card auth-card"><h2>Турнир не найден</h2></div>`); return; }
    t = src;
    starts = new Date(src.starts_at);
    if (isNew) { // копия — та же структура через неделю
      starts.setDate(starts.getDate() + 7);
      while (starts < new Date()) starts.setDate(starts.getDate() + 7);
      t = { ...src, status: 'scheduled', registration_open: true };
    }
  }
  const f = (name, label, type = 'number', extra = '') => `<div class="field"><label>${label}</label><input name="${name}" type="${type}" value="${esc(t[name])}" ${extra}></div>`;
  render(`
    <div style="margin-bottom:14px"><a href="#/admin">← Управление</a></div>
    <div class="page-head"><h1>${isNew ? 'Новый турнир' : 'Редактирование'}</h1></div>
    <form class="card form" id="tForm" style="max-width:820px">
      <div class="field"><label>Название</label><input name="title" required minlength="2" maxlength="120" value="${esc(t.title)}" placeholder="Например: Пятничный турнир"></div>
      <div class="form-grid">
        <div class="field"><label>Дата и время начала</label><input name="starts_at" type="datetime-local" required value="${toLocalInput(starts)}"></div>
        ${f('location', 'Место проведения', 'text', 'maxlength="120" placeholder="Адрес клуба"')}
      </div>
      <div class="field"><label>Описание</label><textarea name="description" maxlength="3000" placeholder="Формат, структура, призы, правила…">${esc(t.description)}</textarea></div>
      <div class="form-grid">
        ${f('buy_in', 'Взнос, ₽', 'number', 'min="0" step="1" required')}
        ${f('rebuy_price', 'Ребай, ₽ (0 — нет)', 'number', 'min="0" step="1"')}
        ${f('addon_price', 'Аддон, ₽ (0 — нет)', 'number', 'min="0" step="1"')}
        ${f('starting_stack', 'Стартовый стек', 'number', 'min="0" step="100" required')}
        ${f('max_players', 'Максимум игроков', 'number', 'min="2" max="1000" required')}
        ${f('seats_per_table', 'Мест за столом', 'number', 'min="2" max="12" required')}
        ${f('points_multiplier', 'Коэффициент очков', 'number', 'min="0" max="99" step="0.1" required')}
        ${!isNew ? `<div class="field"><label>Статус</label><select name="status">${['scheduled', 'running', 'finished', 'cancelled'].map(s => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${{ scheduled: 'Запланирован', running: 'Идёт', finished: 'Завершён', cancelled: 'Отменён' }[s]}</option>`).join('')}</select></div>` : ''}
      </div>
      <label class="check"><input type="checkbox" name="is_rating" ${t.is_rating ? 'checked' : ''}> Рейтинговый турнир (очки идут в топ месяца)</label>
      <label class="check"><input type="checkbox" name="registration_open" ${t.registration_open ? 'checked' : ''}> Запись открыта</label>
      <div class="btn-row"><button class="btn primary lg" type="submit">${isNew ? 'Создать турнир' : 'Сохранить'}</button><a class="btn" href="${isNew ? '#/admin' : '#/t/' + id}">Отмена</a></div>
    </form>`);
  $('#tForm').addEventListener('submit', e => {
    e.preventDefault();
    const d = formData(e.target);
    const row = {
      title: d.title.trim(), description: d.description.trim() || null, location: d.location.trim() || null,
      starts_at: new Date(d.starts_at).toISOString(),
      buy_in: +d.buy_in || 0, rebuy_price: +d.rebuy_price || 0, addon_price: +d.addon_price || 0,
      starting_stack: +d.starting_stack || 0, max_players: +d.max_players, seats_per_table: +d.seats_per_table,
      points_multiplier: +d.points_multiplier, is_rating: !!d.is_rating, registration_open: !!d.registration_open,
    };
    if (!isNew) row.status = d.status;
    busy(e.submitter, async () => {
      if (isNew) {
        row.created_by = state.user.id;
        const created = await q(sb.from('tournaments').insert(row).select('id').single());
        toast('Турнир создан', 'ok');
        location.hash = '#/t/' + created.id;
      } else {
        await q(sb.from('tournaments').update(row).eq('id', id));
        await sb.rpc('promote_waitlist', { p_tournament: id }); // если увеличили число мест
        toast('Сохранено', 'ok');
        location.hash = '#/t/' + id;
      }
    });
  });
}

// ---------------------------------------------------------------- MANAGE TOURNAMENT (крупье)
export async function pageManage({ render, args: [id] }) {
  render(`<div class="loader">Загрузка…</div>`);
  const [t, regs, profiles] = await Promise.all([
    q(sb.from('tournaments_view').select('*').eq('id', id).maybeSingle()),
    q(sb.from('registrations').select('*, profiles(nickname)').eq('tournament_id', id).order('created_at')),
    q(sb.from('profiles').select('id,nickname').eq('is_banned', false).order('nickname').limit(2000)),
  ]);
  if (!t) { render(`<div class="card auth-card"><h2>Турнир не найден</h2></div>`); return; }

  const active = regs.filter(r => r.status !== 'waitlist');
  const wait = regs.filter(r => r.status === 'waitlist');
  const inGame = active.filter(r => !r.place);
  const rebuys = active.reduce((s, r) => s + r.rebuys, 0);
  const addons = active.reduce((s, r) => s + r.addons, 0);
  const pool = active.length * t.buy_in + rebuys * t.rebuy_price + addons * t.addon_price;
  const registeredIds = new Set(regs.map(r => r.user_id).filter(Boolean));
  const finished = t.status === 'finished';

  active.sort((a, b) => {
    if (!!a.place !== !!b.place) return a.place ? 1 : -1;            // сначала те, кто в игре
    if (a.place && b.place) return a.place - b.place;
    return (a.table_no || 99) - (b.table_no || 99) || (a.seat_no || 99) - (b.seat_no || 99) || playerName(a).localeCompare(playerName(b));
  });

  let controls = '';
  if (t.status === 'scheduled') controls = `
    <button class="btn ${t.registration_open ? '' : 'success'}" data-act="toggleReg">${t.registration_open ? 'Закрыть запись' : 'Открыть запись'}</button>
    <button class="btn primary" data-act="start">▶ Начать турнир</button>
    <button class="btn danger" data-act="cancel">Отменить турнир</button>`;
  else if (t.status === 'running') controls = `
    <button class="btn primary" data-act="finish">🏁 Завершить и начислить очки</button>
    <button class="btn" data-act="unstart">Вернуть в «запланирован»</button>`;
  else if (finished) controls = `
    <button class="btn" data-act="recalc">Пересчитать очки</button>
    <button class="btn" data-act="reopen">Возобновить турнир</button>`;
  else controls = `<button class="btn" data-act="unstart">Восстановить турнир</button>`;

  const stepper = (r, f) => `<div class="stepper"><button data-step="${r.id}" data-f="${f}" data-d="-1">−</button><span>${r[f]}</span><button data-step="${r.id}" data-f="${f}" data-d="1">+</button></div>`;
  const rowHtml = (r) => `<tr data-id="${r.id}" style="${r.place ? 'opacity:.75' : ''}">
    <td>${r.user_id ? `<a href="#/player/${r.user_id}"><b>${esc(playerName(r))}</b></a>` : `<b>${esc(r.guest_name)}</b> <span class="muted small">гость</span>`}</td>
    <td><select data-f="status">${Object.entries(REG_LABEL).map(([k, l]) => `<option value="${k}" ${r.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
    <td style="white-space:nowrap"><input class="n" data-f="table_no" type="number" min="1" value="${r.table_no ?? ''}" placeholder="стол"> <input class="n" data-f="seat_no" type="number" min="1" value="${r.seat_no ?? ''}" placeholder="место"></td>
    ${t.rebuy_price ? `<td>${stepper(r, 'rebuys')}</td>` : ''}
    ${t.addon_price ? `<td>${stepper(r, 'addons')}</td>` : ''}
    <td>${stepper(r, 'knockouts')}</td>
    <td><input class="n" data-f="place" type="number" min="1" value="${r.place ?? ''}"></td>
    <td><input class="n" data-f="points" type="number" step="0.1" value="${r.points}"></td>
    <td><input class="w" data-f="prize" type="number" min="0" value="${r.prize || ''}" placeholder="0"></td>
    <td style="white-space:nowrap">
      ${t.status === 'running' && !r.place ? `<button class="btn sm danger" data-bust="${r.id}">Вылет</button>` : ''}
      <button class="btn sm" data-remove="${r.id}" title="Убрать из турнира">✕</button>
    </td></tr>`;

  render(`
    <div style="margin-bottom:14px"><a href="#/t/${t.id}">← Страница турнира</a> · <a href="#/admin">Управление</a></div>
    <div class="page-head">
      <div><div class="btn-row" style="margin-bottom:8px">${statusBadge(t)}</div><h1>${esc(t.title)}</h1><div class="muted">${fmtDateTime(t.starts_at)}</div></div>
      <div class="btn-row">
        <a class="btn" href="timer.html?t=${t.id}&role=tv" target="_blank" rel="noopener">📺 Таймер на TV</a>
        <a class="btn" href="timer.html?t=${t.id}&role=remote" target="_blank" rel="noopener">📱 Пульт таймера</a>
        <a class="btn" href="#/edit/${t.id}">Изменить</a>
      </div>
    </div>
    <div class="info-grid" style="margin-bottom:18px">
      <div class="it"><div class="l">Участников</div><div class="v">${active.length} / ${t.max_players}</div></div>
      <div class="it"><div class="l">В игре</div><div class="v">${inGame.length}</div></div>
      ${t.rebuy_price ? `<div class="it"><div class="l">Ребаев</div><div class="v">${rebuys}</div></div>` : ''}
      ${t.addon_price ? `<div class="it"><div class="l">Аддонов</div><div class="v">${addons}</div></div>` : ''}
      <div class="it"><div class="l">Призовой фонд</div><div class="v">${money(pool)}</div></div>
      <div class="it"><div class="l">Фишек в игре</div><div class="v">${num((active.length + rebuys + addons) * t.starting_stack)}</div></div>
      ${inGame.length ? `<div class="it"><div class="l">Средний стек</div><div class="v">${num(Math.round((active.length + rebuys + addons) * t.starting_stack / inGame.length))}</div></div>` : ''}
    </div>
    <div class="card" style="margin-bottom:18px"><div class="btn-row">${controls}</div>
      ${t.status === 'running' ? `<p class="muted small" style="margin-top:10px">«Вылет» автоматически ставит игроку следующее место. Когда останется один игрок, нажмите «Завершить» — он получит 1-е место, очки рассчитаются автоматически.</p>` : ''}
    </div>

    <div class="card" style="margin-bottom:18px">
      <h3>Добавить игрока</h3>
      <form class="btn-row" id="addForm">
        <input name="who" list="plist" placeholder="Ник игрока или имя гостя" required style="flex:1; min-width:220px">
        <datalist id="plist">${profiles.filter(p => !registeredIds.has(p.id)).map(p => `<option value="${esc(p.nickname)}">`).join('')}</datalist>
        <label class="check small"><input type="checkbox" name="checkin" checked> сразу отметить «пришёл»</label>
        <button class="btn primary" type="submit">Добавить</button>
      </form>
      <p class="muted small" style="margin-top:8px">Если ник не найден среди зарегистрированных — игрок будет добавлен как гость (вне рейтинга).</p>
    </div>

    <div class="section-head" style="margin-top:6px"><h2 style="margin:0">Игроки</h2>
      <div class="btn-row">
        ${t.status !== 'finished' ? `<button class="btn" data-act="checkinAll">Отметить всех «пришёл»</button><button class="btn" data-act="seat">🎲 Случайная рассадка</button>` : ''}
      </div></div>
    ${active.length ? `<div class="table-wrap"><table class="tbl" id="ptable"><thead><tr>
      <th>Игрок</th><th>Статус</th><th>Стол / место</th>${t.rebuy_price ? '<th>Ребаи</th>' : ''}${t.addon_price ? '<th>Аддоны</th>' : ''}<th>KO</th><th>Место</th><th>Очки</th><th>Приз</th><th></th>
    </tr></thead><tbody>${active.map(rowHtml).join('')}</tbody></table></div>` : `<div class="card empty">Пока никто не записан.</div>`}
    ${wait.length ? `<div class="section" style="margin-top:26px"><h2>Лист ожидания · ${wait.length}</h2>
      <div class="table-wrap"><table class="tbl"><tbody>${wait.map((r, i) => `<tr data-id="${r.id}"><td class="muted">${i + 1}</td><td><b>${esc(playerName(r))}</b></td><td class="small muted">${fmtDateTime(r.created_at)}</td>
        <td style="text-align:right"><button class="btn sm success" data-promote="${r.id}">Записать</button> <button class="btn sm" data-remove="${r.id}">✕</button></td></tr>`).join('')}</tbody></table></div></div>` : ''}
  `);

  const upd = (rid, patch) => q(sb.from('registrations').update(patch).eq('id', rid));
  const setT = (patch) => q(sb.from('tournaments').update(patch).eq('id', id));

  // поля в таблице
  $$('#ptable [data-f]').forEach(inp => {
    if (inp.tagName === 'BUTTON') return;
    inp.addEventListener('change', () => busy(null, async () => {
      const rid = inp.closest('tr').dataset.id;
      const f = inp.dataset.f;
      let v = inp.value;
      if (f !== 'status') v = v === '' ? (f === 'points' || f === 'prize' ? 0 : null) : Number(v);
      await upd(rid, { [f]: v });
      if (f === 'status' && v === 'waitlist') { await sb.rpc('promote_waitlist', { p_tournament: id }); reload(); return; }
      if (f === 'place' && finished) await q(sb.rpc('recalc_points', { p_tournament: id }));
      if (['place', 'status'].includes(f)) reload(); else toast('Сохранено', 'ok');
    }));
  });
  $$('[data-step]').forEach(b => b.onclick = () => busy(null, async () => {
    const r = regs.find(x => x.id === b.dataset.step);
    const v = Math.max(0, r[b.dataset.f] + Number(b.dataset.d));
    await upd(r.id, { [b.dataset.f]: v });
    reload();
  }));
  $$('[data-bust]').forEach(b => b.onclick = () => busy(b, async () => {
    const r = regs.find(x => x.id === b.dataset.bust);
    await upd(r.id, { place: inGame.length, table_no: null, seat_no: null });
    toast(`${playerName(r)} — ${inGame.length}-е место`);
    reload();
  }));
  $$('[data-remove]').forEach(b => b.onclick = async () => {
    const r = regs.find(x => x.id === b.dataset.remove);
    if (!await confirmDialog('Убрать игрока?', `${playerName(r)} будет удалён из турнира.`, 'Убрать', true)) return;
    busy(b, async () => {
      await q(sb.from('registrations').delete().eq('id', r.id));
      await sb.rpc('promote_waitlist', { p_tournament: id });
      reload();
    });
  });
  $$('[data-promote]').forEach(b => b.onclick = () => busy(b, async () => { await upd(b.dataset.promote, { status: 'registered' }); reload(); }));

  $('#addForm').onsubmit = (e) => {
    e.preventDefault();
    const d = formData(e.target);
    const who = d.who.trim();
    if (!who) return;
    busy(e.submitter, async () => {
      const p = profiles.find(x => x.nickname.toLowerCase() === who.toLowerCase());
      if (p && registeredIds.has(p.id)) { toast('Этот игрок уже в турнире', 'err'); return; }
      if (active.length >= t.max_players && !await confirmDialog('Мест нет', `Лимит ${t.max_players} игроков уже достигнут. Всё равно добавить?`, 'Добавить')) return;
      await q(sb.from('registrations').insert({ tournament_id: id, user_id: p ? p.id : null, guest_name: p ? null : who, status: d.checkin ? 'checked_in' : 'registered' }));
      toast(p ? `${p.nickname} добавлен` : `Гость «${who}» добавлен`, 'ok');
      reload();
    });
  };

  // действия с турниром
  const actions = {
    toggleReg: async () => { await setT({ registration_open: !t.registration_open }); },
    start: async () => {
      if (!await confirmDialog('Начать турнир?', 'Запись закроется, игроки не смогут сами отменить бронь.', 'Начать')) return false;
      await setT({ status: 'running', registration_open: false });
      toast('Турнир начался! Удачи за столами 🍀', 'ok');
    },
    unstart: async () => { await setT({ status: 'scheduled' }); },
    cancel: async () => {
      if (!await confirmDialog('Отменить турнир?', 'Турнир будет помечен как отменённый.', 'Отменить турнир', true)) return false;
      await setT({ status: 'cancelled', registration_open: false });
    },
    finish: async () => {
      const left = inGame.length;
      const msg = left > 1 ? `В игре ещё ${left} игроков без места — они не получат очков. Завершить?` : 'Очки рейтинга будут начислены всем участникам.';
      if (!await confirmDialog('Завершить турнир?', msg, 'Завершить')) return false;
      await q(sb.rpc('finish_tournament', { p_tournament: id }));
      toast('Турнир завершён, очки начислены 🏆', 'ok');
    },
    recalc: async () => { await q(sb.rpc('recalc_points', { p_tournament: id })); toast('Очки пересчитаны', 'ok'); },
    reopen: async () => { await setT({ status: 'running' }); },
    checkinAll: async () => {
      await q(sb.from('registrations').update({ status: 'checked_in' }).eq('tournament_id', id).eq('status', 'registered'));
    },
    seat: async () => {
      const players = active.filter(r => !r.place);
      if (!players.length) return false;
      if (players.some(r => r.table_no) && !await confirmDialog('Пересадить всех?', 'Текущая рассадка будет заменена случайной.', 'Рассадить')) return false;
      for (let i = players.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [players[i], players[j]] = [players[j], players[i]]; }
      const tables = Math.ceil(players.length / t.seats_per_table);
      await Promise.all(players.map((r, i) => upd(r.id, { table_no: (i % tables) + 1, seat_no: Math.floor(i / tables) + 1 })));
      toast(`Рассажено за ${tables} ${tables === 1 ? 'стол' : tables < 5 ? 'стола' : 'столов'}`, 'ok');
    },
  };
  $$('[data-act]').forEach(b => b.onclick = () => busy(b, async () => {
    const res = await actions[b.dataset.act]();
    if (res !== false) reload();
  }));
}
