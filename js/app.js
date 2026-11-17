import {
  sb, configured, state, isStaff, isAdmin, loadProfile, q, esc, money, num, pts, fmtDate, fmtTime, fmtDateTime,
  monthName, monthRange, statusBadge, roleBadge, placeHtml, playerLink, playerName, initial, tournamentCard, REG_LABEL,
  toast, toastErr, confirmDialog, closeModal, busy, $, $$, formData, humanError, CLUB,
} from './core.js';
import { pageAdmin, pageEditTournament, pageManage } from './staff.js';

const app = document.getElementById('app');
const render = (html) => { app.innerHTML = html; window.scrollTo(0, 0); };

// ---------------------------------------------------------------- ROUTER
const routes = [
  [/^\/?$/, pageHome],
  [/^\/tournaments$/, pageTournaments],
  [/^\/t\/([\w-]+)$/, pageTournament],
  [/^\/rating$/, pageRating],
  [/^\/rules$/, pageRules],
  [/^\/player\/([\w-]+)$/, pagePlayer],
  [/^\/profile$/, pageProfile, 'auth'],
  [/^\/login$/, pageLogin],
  [/^\/register$/, pageRegister],
  [/^\/forgot$/, pageForgot],
  [/^\/new-password$/, pageNewPassword, 'auth'],
  [/^\/admin$/, pageAdmin, 'staff'],
  [/^\/admin\/(users)$/, pageAdmin, 'staff'],
  [/^\/edit\/([\w-]+)$/, pageEditTournament, 'staff'],
  [/^\/manage\/([\w-]+)$/, pageManage, 'staff'],
];

let routeToken = 0;
const STALE = Symbol('stale'); // страница сменилась, пока шла загрузка — прекращаем отрисовку
export async function router() {
  const raw = location.hash.replace(/^#/, '') || '/';
  if (/access_token=|error_description=|type=recovery/.test(raw)) return; // обрабатывает supabase-js
  const [path, query] = raw.split('?');
  const params = new URLSearchParams(query || '');
  closeModal();
  document.getElementById('nav').classList.remove('open');
  $$('#nav a[data-nav]').forEach(a => a.classList.toggle('active', path.startsWith('/' + a.dataset.nav)));

  if (!configured) {
    render(`<div class="card auth-card"><h2>Сайт не настроен</h2><p class="muted">Заполните SUPABASE_URL и SUPABASE_ANON_KEY в файле <b>js/config.js</b>.</p></div>`);
    return;
  }
  for (const [re, fn, guard] of routes) {
    const m = path.match(re);
    if (!m) continue;
    if (guard === 'auth' && !state.user) { location.hash = '#/login?next=' + encodeURIComponent(path); return; }
    if (guard === 'staff' && !isStaff()) {
      render(state.user
        ? `<div class="card auth-card"><h2>Нет доступа</h2><p class="muted">Этот раздел доступен только крупье и администраторам.</p></div>`
        : `<div class="card auth-card"><h2>Нужно войти</h2><p class="muted" style="margin-bottom:16px">Раздел для крупье и администраторов.</p><a class="btn primary" href="#/login?next=${encodeURIComponent(path)}">Войти</a></div>`);
      return;
    }
    const token = ++routeToken;
    try {
      await fn({ args: m.slice(1), params, render: (html) => { if (token !== routeToken) throw STALE; render(html); }, isCurrent: () => token === routeToken });
    } catch (e) {
      if (e === STALE) return;
      console.error(e);
      if (token === routeToken) render(`<div class="card auth-card"><h2>Ошибка</h2><p class="muted">${esc(humanError(e))}</p><button class="btn" style="margin-top:14px" onclick="location.reload()">Обновить</button></div>`);
    }
    return;
  }
  render(`<div class="card auth-card"><h2>Страница не найдена</h2><a class="btn" href="#/">На главную</a></div>`);
}
export const reload = () => router();

function updateHeader() {
  const logged = !!state.user;
  $$('.guest-only').forEach(e => e.classList.toggle('hidden', logged));
  $$('.user-only').forEach(e => e.classList.toggle('hidden', !logged));
  $$('.staff-only').forEach(e => e.classList.toggle('hidden', !isStaff()));
  const nick = state.profile?.nickname || state.user?.email || 'Профиль';
  $('#navNick').textContent = nick;
  $('#navAvatar').textContent = (nick[0] || '?').toUpperCase();
}

// ---------------------------------------------------------------- HOME
async function pageHome({ render }) {
  render(`<div class="loader">Загрузка…</div>`);
  const now = new Date();
  const [from, to] = monthRange(now.getFullYear(), now.getMonth());
  const [upcoming, top, counts] = await Promise.all([
    q(sb.from('tournaments_view').select('*').in('status', ['scheduled', 'running']).order('starts_at').limit(6)),
    q(sb.rpc('get_leaderboard', { p_from: from.toISOString(), p_to: to.toISOString() })),
    Promise.all([
      sb.from('profiles').select('id', { count: 'exact', head: true }),
      sb.from('tournaments').select('id', { count: 'exact', head: true }).eq('status', 'finished'),
    ]),
  ]);
  const mine = await myStatuses(upcoming.map(t => t.id));
  render(`
    <section class="hero">
      <div class="chips-deco"></div>
      <h1>${esc(CLUB)}<br><span style="color:var(--cream)">спортивный покер</span></h1>
      <p>Турниры по спортивному покеру каждую неделю. Регистрируйтесь, бронируйте место за столом и поднимайтесь в рейтинге месяца.</p>
      <div class="btn-row">
        <a class="btn primary lg" href="#/tournaments">Расписание турниров</a>
        ${state.user ? `<a class="btn lg" href="#/profile">Мой профиль</a>` : `<a class="btn lg" href="#/register">Создать аккаунт</a>`}
      </div>
      <div class="stats-row">
        <div class="stat"><div class="v">${num(counts[0].count)}</div><div class="l">игроков</div></div>
        <div class="stat"><div class="v">${num(counts[1].count)}</div><div class="l">турниров сыграно</div></div>
        <div class="stat"><div class="v">${upcoming.length}</div><div class="l">в расписании</div></div>
      </div>
    </section>
    <section class="section">
      <div class="section-head"><h2>Ближайшие турниры</h2><a href="#/tournaments">Все турниры →</a></div>
      ${upcoming.length ? `<div class="t-list">${upcoming.map(t => tournamentCard(t, mine[t.id])).join('')}</div>`
        : `<div class="card empty">Скоро здесь появятся новые турниры.</div>`}
    </section>
    <section class="section">
      <div class="section-head"><h2>Топ месяца · ${monthName(now)}</h2><a href="#/rating">Полный рейтинг →</a></div>
      ${leaderTable(top.slice(0, 10), false)}
    </section>`);
}

async function myStatuses(ids) {
  if (!state.user || !ids.length) return {};
  const rows = await q(sb.from('registrations').select('tournament_id,status').eq('user_id', state.user.id).in('tournament_id', ids));
  return Object.fromEntries(rows.map(r => [r.tournament_id, r.status]));
}

// ---------------------------------------------------------------- TOURNAMENTS
async function pageTournaments({ render, params }) {
  const tab = params.get('tab') === 'past' ? 'past' : 'upcoming';
  render(`<div class="loader">Загрузка…</div>`);
  let qb = sb.from('tournaments_view').select('*');
  qb = tab === 'past'
    ? qb.in('status', ['finished', 'cancelled']).order('starts_at', { ascending: false }).limit(60)
    : qb.in('status', ['scheduled', 'running']).order('starts_at');
  const list = await q(qb);
  const mine = await myStatuses(list.map(t => t.id));
  render(`
    <div class="page-head"><h1>Турниры</h1>${isStaff() ? `<a class="btn primary" href="#/edit/new">+ Создать турнир</a>` : ''}</div>
    <div class="tabs">
      <a href="#/tournaments" class="${tab === 'upcoming' ? 'active' : ''}">Предстоящие</a>
      <a href="#/tournaments?tab=past" class="${tab === 'past' ? 'active' : ''}">Прошедшие</a>
    </div>
    ${list.length ? `<div class="t-list">${list.map(t => tournamentCard(t, mine[t.id])).join('')}</div>`
      : `<div class="card empty">${tab === 'past' ? 'Пока нет прошедших турниров.' : 'Нет запланированных турниров. Загляните позже!'}</div>`}`);
}

async function pageTournament({ args: [id], render }) {
  render(`<div class="loader">Загрузка…</div>`);
  const [t, regs] = await Promise.all([
    q(sb.from('tournaments_view').select('*').eq('id', id).maybeSingle()),
    q(sb.from('registrations').select('id,user_id,guest_name,status,place,points,knockouts,prize,table_no,seat_no,created_at,profiles(nickname)').eq('tournament_id', id).order('created_at')),
  ]);
  if (!t) { render(`<div class="card auth-card"><h2>Турнир не найден</h2><a class="btn" href="#/tournaments">К списку</a></div>`); return; }
  const my = state.user ? regs.find(r => r.user_id === state.user.id) : null;
  const active = regs.filter(r => r.status !== 'waitlist');
  const wait = regs.filter(r => r.status === 'waitlist');
  const free = Math.max(0, t.max_players - t.seats_taken);
  const finished = t.status === 'finished';

  let booking;
  if (t.status === 'cancelled') booking = `<div class="notice warn">Турнир отменён.</div>`;
  else if (finished) booking = my ? `<div class="notice gold">Вы участвовали: место <b>${my.place || '—'}</b>, очки <b>${pts(my.points)}</b>.</div>` : `<div class="notice">Турнир завершён.</div>`;
  else if (!state.user) booking = `<div class="notice">Чтобы забронировать место, <a href="#/login?next=/t/${t.id}">войдите</a> или <a href="#/register">зарегистрируйтесь</a>.</div>`;
  else if (state.profile?.is_banned) booking = `<div class="notice warn">Ваш аккаунт заблокирован.</div>`;
  else if (my) {
    const canCancel = t.status === 'scheduled';
    booking = `<div class="notice ${my.status === 'waitlist' ? '' : 'ok'}" style="margin-bottom:12px">
        ${my.status === 'waitlist' ? `Вы в <b>листе ожидания</b> (№${wait.findIndex(r => r.id === my.id) + 1}). Если место освободится — вы будете записаны автоматически.` : `Место забронировано за вами.${my.table_no ? ` Стол <b>${my.table_no}</b>, место <b>${my.seat_no || '—'}</b>.` : ''}`}
      </div>
      ${canCancel ? `<button class="btn danger block" id="cancelBtn">Отменить бронь</button>` : `<div class="muted small">Турнир уже идёт — для отмены обратитесь к крупье.</div>`}`;
  } else if (t.status === 'scheduled' && t.registration_open) {
    booking = `<button class="btn primary lg block" id="bookBtn">${free > 0 ? 'Забронировать место' : 'Встать в лист ожидания'}</button>
      <div class="muted small" style="margin-top:8px; text-align:center">${free > 0 ? `Свободно мест: ${free} из ${t.max_players}` : 'Все места заняты'}</div>`;
  } else booking = `<div class="notice">Запись на турнир закрыта.</div>`;

  const results = [...active].sort((a, b) => (a.place || 9999) - (b.place || 9999));
  render(`
    <div style="margin-bottom:14px"><a href="#/tournaments">← Все турниры</a></div>
    <div class="page-head">
      <div><div class="btn-row" style="margin-bottom:10px">${statusBadge(t)} ${t.is_rating ? '<span class="badge me">Рейтинговый</span>' : '<span class="badge closed">Вне рейтинга</span>'}</div>
        <h1>${esc(t.title)}</h1>
        <div class="muted" style="margin-top:6px">${fmtDateTime(t.starts_at)}${t.location ? ' · ' + esc(t.location) : ''}</div></div>
      ${isStaff() ? `<div class="btn-row"><a class="btn" href="#/edit/${t.id}">Редактировать</a><a class="btn primary" href="#/manage/${t.id}">Управлять турниром</a></div>` : ''}
    </div>
    <div class="split">
      <div>
        <div class="info-grid">
          <div class="it"><div class="l">Взнос</div><div class="v">${money(t.buy_in)}</div></div>
          ${t.rebuy_price ? `<div class="it"><div class="l">Ребай</div><div class="v">${money(t.rebuy_price)}</div></div>` : ''}
          ${t.addon_price ? `<div class="it"><div class="l">Аддон</div><div class="v">${money(t.addon_price)}</div></div>` : ''}
          <div class="it"><div class="l">Стартовый стек</div><div class="v">${num(t.starting_stack)}</div></div>
          <div class="it"><div class="l">Мест</div><div class="v">${t.seats_taken} / ${t.max_players}</div></div>
          ${t.is_rating && Number(t.points_multiplier) !== 1 ? `<div class="it"><div class="l">Коэф. очков</div><div class="v">×${pts(t.points_multiplier)}</div></div>` : ''}
        </div>
        ${t.description ? `<div class="card" style="margin-top:16px"><div class="desc">${esc(t.description)}</div></div>` : ''}

        <div class="section" style="margin-top:28px">
          ${finished ? `<h2>Результаты</h2>
            <div class="table-wrap"><table class="tbl"><thead><tr><th>Место</th><th>Игрок</th><th class="num">KO</th><th class="num">Очки</th><th class="num">Приз</th></tr></thead><tbody>
            ${results.map(r => `<tr class="${state.user && r.user_id === state.user.id ? 'me' : ''}"><td>${placeHtml(r.place)}</td><td>${playerLink(r)}</td><td class="num">${r.knockouts || ''}</td><td class="num">${pts(r.points)}</td><td class="num">${r.prize ? money(r.prize) : ''}</td></tr>`).join('') || `<tr><td colspan="5" class="empty">Нет данных</td></tr>`}
            </tbody></table></div>`
          : `<h2>Участники · ${active.length}</h2>
            ${active.length ? `<div class="player-list">${active.map(chip).join('')}</div>` : `<div class="card empty">Пока никто не записался. Будьте первым!</div>`}
            ${wait.length ? `<h3 style="margin-top:22px">Лист ожидания · ${wait.length}</h3><div class="player-list">${wait.map(chip).join('')}</div>` : ''}`}
        </div>
      </div>
      <aside class="card" style="position:sticky; top:80px">
        <h3>Бронирование</h3>
        <div class="muted small" style="margin-bottom:14px">${fmtDate(t.starts_at)}, начало в ${fmtTime(t.starts_at)}</div>
        ${booking}
      </aside>
    </div>`);

  function chip(r) {
    const me = state.user && r.user_id === state.user.id;
    const inner = `<span class="avatar sm">${initial(playerName(r))}</span>${esc(playerName(r))}${r.status === 'checked_in' ? ' ✓' : ''}`;
    return r.user_id ? `<a class="player-chip ${me ? 'me' : ''}" href="#/player/${r.user_id}">${inner}</a>` : `<span class="player-chip">${inner}</span>`;
  }

  $('#bookBtn')?.addEventListener('click', e => busy(e.currentTarget, async () => {
    const st = await q(sb.rpc('book_seat', { p_tournament: id }));
    toast(st === 'waitlist' ? 'Вы добавлены в лист ожидания' : 'Место забронировано!', 'ok');
    reload();
  }));
  $('#cancelBtn')?.addEventListener('click', async e => {
    if (!await confirmDialog('Отменить бронь?', 'Ваше место освободится для других игроков.', 'Отменить бронь', true)) return;
    busy(e.currentTarget, async () => {
      await q(sb.rpc('cancel_booking', { p_tournament: id }));
      toast('Бронь отменена');
      reload();
    });
  });
}

// ---------------------------------------------------------------- RATING
function leaderTable(rows, full = true) {
  if (!rows.length) return `<div class="card empty">В этом периоде ещё нет сыгранных рейтинговых турниров.</div>`;
  const meId = state.user?.id;
  return `<div class="table-wrap"><table class="tbl"><thead><tr>
      <th>#</th><th>Игрок</th><th class="num">Очки</th><th class="num">Игр</th><th class="num">Побед</th>${full ? '<th class="num">Топ-3</th><th class="num">Лучшее</th><th class="num">KO</th>' : ''}
    </tr></thead><tbody>
    ${rows.map((r, i) => `<tr class="${r.user_id === meId ? 'me' : ''}">
      <td>${placeHtml(i + 1)}</td><td><a href="#/player/${r.user_id}">${esc(r.nickname)}</a></td>
      <td class="num"><b>${pts(r.points)}</b></td><td class="num">${r.games}</td><td class="num">${r.wins}</td>
      ${full ? `<td class="num">${r.top3}</td><td class="num">${r.best_place || '—'}</td><td class="num">${r.knockouts}</td>` : ''}
    </tr>`).join('')}
  </tbody></table></div>`;
}

async function pageRating({ render, params }) {
  const all = params.get('all') === '1';
  const now = new Date();
  let y = +params.get('y') || now.getFullYear();
  let m = params.has('m') ? +params.get('m') : now.getMonth();
  const [from, to] = monthRange(y, m);
  render(`<div class="loader">Загрузка…</div>`);
  const rows = await q(all ? sb.rpc('get_leaderboard', {}) : sb.rpc('get_leaderboard', { p_from: from.toISOString(), p_to: to.toISOString() }));
  const prev = new Date(y, m - 1, 1), next = new Date(y, m + 1, 1);
  const isFuture = next > new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const top = rows.slice(0, 3);
  const meIdx = state.user ? rows.findIndex(r => r.user_id === state.user.id) : -1;
  const pod = (r, i, cls) => r ? `<div class="pod ${cls}"><div class="crown">${['🥇', '🥈', '🥉'][i]}</div><div class="nick"><a href="#/player/${r.user_id}">${esc(r.nickname)}</a></div><div class="pts">${pts(r.points)}</div><div class="muted small">${r.games} игр · ${r.wins} побед</div></div>` : `<div class="pod ${cls}"><div class="crown">${['🥇', '🥈', '🥉'][i]}</div><div class="muted small" style="margin-top:8px">—</div></div>`;
  render(`
    <div class="page-head"><h1>${all ? 'Рейтинг за всё время' : 'Топ месяца'}</h1>
      <div class="btn-row">
        ${all ? `<a class="btn" href="#/rating">По месяцам</a>` : `
          <div class="month-switch">
            <a class="btn sm" href="#/rating?y=${prev.getFullYear()}&m=${prev.getMonth()}">‹</a>
            <span class="label">${monthName(from)}</span>
            ${isFuture ? `<span class="btn sm" style="opacity:.3">›</span>` : `<a class="btn sm" href="#/rating?y=${next.getFullYear()}&m=${next.getMonth()}">›</a>`}
          </div>
          <a class="btn" href="#/rating?all=1">За всё время</a>`}
      </div>
    </div>
    ${meIdx >= 0 ? `<div class="notice gold" style="margin-bottom:18px">Вы на <b>${meIdx + 1}-м месте</b> · ${pts(rows[meIdx].points)} очков</div>` : ''}
    ${rows.length ? `<div class="podium">${pod(top[1], 1, '')}${pod(top[0], 0, 'first')}${pod(top[2], 2, '')}</div>` : ''}
    ${leaderTable(rows)}
    <p class="muted small" style="margin-top:14px">Очки начисляются за рейтинговые турниры. <a href="#/rules">Как считаются очки?</a></p>`);
}

function pageRules({ render }) {
  const ex = [1, 2, 3, 5, 10, 20].map(p => `<tr><td>${p}</td><td class="num">${pts(Math.round(10 * Math.sqrt(20) / Math.sqrt(p) * 10) / 10)}</td></tr>`).join('');
  render(`
    <div class="page-head"><h1>Правила рейтинга</h1></div>
    <div class="grid-2">
      <div class="card">
        <h3>Как начисляются очки</h3>
        <p style="margin-bottom:12px">За каждый рейтинговый турнир игрок получает очки по формуле:</p>
        <div class="notice gold mono" style="margin-bottom:12px">очки = 10 × √N ÷ √место × коэффициент</div>
        <p class="muted">N — число участников турнира, коэффициент задаётся для турнира (обычно ×1, для особых турниров больше). Чем больше игроков и чем выше место — тем больше очков. Очки получает каждый участник.</p>
        <p class="muted" style="margin-top:12px">Топ месяца — сумма очков за все турниры календарного месяца. При равенстве очков выше тот, у кого больше побед и попаданий в топ-3.</p>
      </div>
      <div class="card">
        <h3>Пример: турнир на 20 игроков</h3>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Место</th><th class="num">Очки</th></tr></thead><tbody>${ex}</tbody></table></div>
      </div>
    </div>
    <div class="card" style="margin-top:18px">
      <h3>Бронирование мест</h3>
      <p class="muted">Зарегистрируйтесь, откройте турнир и нажмите «Забронировать место». Если мест нет — вы попадёте в лист ожидания и будете записаны автоматически, когда кто-то отменит бронь. Отменить бронь можно до начала турнира.</p>
    </div>`);
}

// ---------------------------------------------------------------- PLAYER / PROFILE
async function playerStats(userId) {
  const rows = await q(sb.from('registrations')
    .select('id,status,place,points,knockouts,prize,rebuys,tournaments!inner(id,title,starts_at,status,is_rating,max_players)')
    .eq('user_id', userId));
  rows.sort((a, b) => new Date(b.tournaments.starts_at) - new Date(a.tournaments.starts_at));
  const played = rows.filter(r => r.tournaments.status === 'finished' && r.status !== 'waitlist');
  const upcoming = rows.filter(r => ['scheduled', 'running'].includes(r.tournaments.status)).reverse();
  const now = new Date();
  const [mf, mt] = monthRange(now.getFullYear(), now.getMonth());
  const month = played.filter(r => { const d = new Date(r.tournaments.starts_at); return d >= mf && d < mt && r.tournaments.is_rating; });
  const sum = (a, f) => a.reduce((s, r) => s + (Number(r[f]) || 0), 0);
  return {
    played, upcoming,
    games: played.length,
    wins: played.filter(r => r.place === 1).length,
    top3: played.filter(r => r.place && r.place <= 3).length,
    points: sum(played.filter(r => r.tournaments.is_rating), 'points'),
    monthPoints: sum(month, 'points'),
    ko: sum(played, 'knockouts'),
    prizes: sum(played, 'prize'),
  };
}

function statsBlock(s) {
  return `<div class="info-grid">
    <div class="it"><div class="l">Очки за месяц</div><div class="v">${pts(s.monthPoints)}</div></div>
    <div class="it"><div class="l">Очки всего</div><div class="v">${pts(s.points)}</div></div>
    <div class="it"><div class="l">Турниров</div><div class="v">${s.games}</div></div>
    <div class="it"><div class="l">Побед</div><div class="v">${s.wins}</div></div>
    <div class="it"><div class="l">Топ-3</div><div class="v">${s.top3}</div></div>
    <div class="it"><div class="l">Нокаутов</div><div class="v">${s.ko}</div></div>
  </div>`;
}

function historyTable(played) {
  if (!played.length) return `<div class="card empty">Пока нет сыгранных турниров.</div>`;
  return `<div class="table-wrap"><table class="tbl"><thead><tr><th>Дата</th><th>Турнир</th><th>Место</th><th class="num">KO</th><th class="num">Очки</th></tr></thead><tbody>
    ${played.map(r => `<tr><td class="small muted" style="white-space:nowrap">${fmtDate(r.tournaments.starts_at)}</td><td><a href="#/t/${r.tournaments.id}">${esc(r.tournaments.title)}</a></td><td>${placeHtml(r.place)}</td><td class="num">${r.knockouts || ''}</td><td class="num">${r.tournaments.is_rating ? pts(r.points) : '—'}</td></tr>`).join('')}
  </tbody></table></div>`;
}

async function pagePlayer({ args: [id], render }) {
  if (state.user && id === state.user.id) { location.hash = '#/profile'; return; }
  render(`<div class="loader">Загрузка…</div>`);
  const [p, s] = await Promise.all([q(sb.from('profiles').select('*').eq('id', id).maybeSingle()), playerStats(id)]);
  if (!p) { render(`<div class="card auth-card"><h2>Игрок не найден</h2></div>`); return; }
  render(`
    <div class="card"><div class="profile-head"><span class="avatar">${initial(p.nickname)}</span>
      <div><h1 style="font-size:40px">${esc(p.nickname)}</h1>
      <div class="btn-row" style="margin-top:6px">${p.role !== 'player' ? roleBadge(p.role) : ''}${p.full_name ? `<span class="muted">${esc(p.full_name)}</span>` : ''}${p.city ? `<span class="muted">· ${esc(p.city)}</span>` : ''}</div></div></div>
      ${p.about ? `<p class="desc" style="margin-top:14px">${esc(p.about)}</p>` : ''}
    </div>
    <div class="section" style="margin-top:22px">${statsBlock(s)}</div>
    <div class="section"><h2>История турниров</h2>${historyTable(s.played)}</div>`);
}

async function pageProfile({ render, params }) {
  render(`<div class="loader">Загрузка…</div>`);
  const tab = params.get('tab') || 'overview';
  const p = state.profile;
  if (!p) {
    render(`<div class="card auth-card"><h2>Профиль не найден</h2><p class="muted">Похоже, база данных ещё не настроена (выполните supabase/schema.sql) или профиль не создан.</p><button class="btn" id="logoutBtn" style="margin-top:14px">Выйти</button></div>`);
    $('#logoutBtn').onclick = logout;
    return;
  }
  const [s, contacts] = await Promise.all([
    playerStats(p.id),
    q(sb.from('profile_contacts').select('*').eq('user_id', p.id).maybeSingle()),
  ]);
  const c = contacts || {};
  const tabs = [['overview', 'Обзор'], ['history', 'История'], ['settings', 'Настройки']];
  let body = '';
  if (tab === 'overview') {
    body = `${statsBlock(s)}
      <div class="section" style="margin-top:28px"><h2>Мои брони</h2>
      ${s.upcoming.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Дата</th><th>Турнир</th><th>Статус</th></tr></thead><tbody>
        ${s.upcoming.map(r => `<tr><td class="small" style="white-space:nowrap">${fmtDateTime(r.tournaments.starts_at)}</td><td><a href="#/t/${r.tournaments.id}">${esc(r.tournaments.title)}</a></td><td><span class="badge ${r.status === 'waitlist' ? 'wait' : 'me'}">${REG_LABEL[r.status]}</span></td></tr>`).join('')}
      </tbody></table></div>` : `<div class="card empty">У вас нет активных броней. <a href="#/tournaments">Выбрать турнир →</a></div>`}</div>`;
  } else if (tab === 'history') {
    body = historyTable(s.played);
  } else {
    body = `<div class="grid-2">
      <form class="card form" id="profileForm">
        <h3>Личные данные</h3>
        <div class="field"><label>Ник (виден всем)</label><input name="nickname" required minlength="2" maxlength="24" value="${esc(p.nickname)}"></div>
        <div class="field"><label>Имя и фамилия</label><input name="full_name" maxlength="80" value="${esc(p.full_name)}"></div>
        <div class="field"><label>Город</label><input name="city" maxlength="60" value="${esc(p.city)}"></div>
        <div class="field"><label>О себе</label><textarea name="about" maxlength="500">${esc(p.about)}</textarea></div>
        <div class="field"><label>Телефон <span class="muted">(виден только администрации)</span></label><input name="phone" type="tel" maxlength="30" value="${esc(c.phone)}"></div>
        <div class="field"><label>Telegram <span class="muted">(виден только администрации)</span></label><input name="telegram" maxlength="40" placeholder="@username" value="${esc(c.telegram)}"></div>
        <button class="btn primary" type="submit">Сохранить</button>
      </form>
      <div>
        <form class="card form" id="passForm">
          <h3>Смена пароля</h3>
          <div class="field"><label>Новый пароль</label><input name="password" type="password" minlength="6" required autocomplete="new-password"></div>
          <button class="btn" type="submit">Изменить пароль</button>
        </form>
        <div class="card"><h3>Аккаунт</h3><dl class="kv"><dt>Email</dt><dd>${esc(state.user.email)}</dd><dt>Роль</dt><dd>${roleBadge(p.role)}</dd><dt>С нами с</dt><dd>${fmtDate(p.created_at)}</dd></dl></div>
      </div>
    </div>`;
  }
  render(`
    <div class="page-head">
      <div class="profile-head"><span class="avatar">${initial(p.nickname)}</span>
        <div><h1 style="font-size:40px">${esc(p.nickname)}</h1><div class="btn-row" style="margin-top:4px">${roleBadge(p.role)}${p.is_banned ? '<span class="badge banned">Заблокирован</span>' : ''}</div></div></div>
      <div class="btn-row"><a class="btn" href="#/player/${p.id}" id="publicLink">Публичный профиль</a><button class="btn danger" id="logoutBtn">Выйти</button></div>
    </div>
    <div class="tabs">${tabs.map(([k, l]) => `<a href="#/profile?tab=${k}" class="${tab === k ? 'active' : ''}">${l}</a>`).join('')}</div>
    ${body}`);

  $('#publicLink').style.display = 'none'; // собственный профиль и так открыт
  $('#logoutBtn').onclick = logout;
  $('#profileForm')?.addEventListener('submit', e => {
    e.preventDefault();
    const d = formData(e.target);
    busy(e.submitter, async () => {
      await q(sb.from('profiles').update({ nickname: d.nickname.trim(), full_name: d.full_name.trim() || null, city: d.city.trim() || null, about: d.about.trim() || null }).eq('id', p.id));
      await q(sb.from('profile_contacts').upsert({ user_id: p.id, email: state.user.email, phone: d.phone.trim() || null, telegram: d.telegram.trim() || null }));
      await loadProfile(); updateHeader();
      toast('Профиль сохранён', 'ok');
    });
  });
  $('#passForm')?.addEventListener('submit', e => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const { error } = await sb.auth.updateUser({ password: formData(e.target).password });
      if (error) throw error;
      e.target.reset();
      toast('Пароль изменён', 'ok');
    });
  });
}

async function logout() {
  await sb.auth.signOut();
  toast('Вы вышли из аккаунта');
  location.hash = '#/';
}

// ---------------------------------------------------------------- AUTH
const siteUrl = () => location.origin + location.pathname;

function pageLogin({ render, params }) {
  if (state.user) { location.hash = '#' + (params.get('next') || '/profile'); return; }
  render(`<form class="card auth-card form" id="loginForm">
    <h2>Вход</h2>
    <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="email"></div>
    <div class="field"><label>Пароль</label><input name="password" type="password" required autocomplete="current-password"></div>
    <div class="form-error" id="err"></div>
    <button class="btn primary lg" type="submit">Войти</button>
    <div class="btn-row" style="justify-content:space-between"><a href="#/forgot">Забыли пароль?</a><a href="#/register">Регистрация</a></div>
  </form>`);
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const d = formData(e.target);
    $('#err').textContent = '';
    await busy(e.submitter, async () => {
      const { error } = await sb.auth.signInWithPassword({ email: d.email.trim(), password: d.password });
      if (error) { $('#err').textContent = humanError(error); return; }
      await onAuth();
      toast('С возвращением, ' + (state.profile?.nickname || '') + '!', 'ok');
      location.hash = '#' + (params.get('next') || '/');
    });
  });
}

function pageRegister({ render }) {
  if (state.user) { location.hash = '#/profile'; return; }
  render(`<form class="card auth-card form" id="regForm">
    <h2>Регистрация игрока</h2>
    <div class="field"><label>Ник (будет в рейтинге)</label><input name="nickname" required minlength="2" maxlength="24" autocomplete="nickname"></div>
    <div class="field"><label>Имя и фамилия</label><input name="full_name" maxlength="80" autocomplete="name"></div>
    <div class="field"><label>Телефон</label><input name="phone" type="tel" maxlength="30" autocomplete="tel" placeholder="+7 900 000-00-00"></div>
    <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="email"></div>
    <div class="field"><label>Пароль</label><input name="password" type="password" required minlength="6" autocomplete="new-password"><span class="hint">Минимум 6 символов</span></div>
    <div class="form-error" id="err"></div>
    <button class="btn primary lg" type="submit">Создать аккаунт</button>
    <div class="muted small" style="text-align:center">Уже есть аккаунт? <a href="#/login">Войти</a></div>
  </form>`);
  $('#regForm').addEventListener('submit', async e => {
    e.preventDefault();
    const d = formData(e.target);
    $('#err').textContent = '';
    const nickname = d.nickname.trim();
    await busy(e.submitter, async () => {
      const { count } = await sb.from('profiles').select('id', { count: 'exact', head: true }).ilike('nickname', nickname.replace(/[%_\\]/g, '\\$&'));
      if (count) { $('#err').textContent = 'Этот ник уже занят'; return; }
      const { data, error } = await sb.auth.signUp({
        email: d.email.trim(), password: d.password,
        options: { data: { nickname, full_name: d.full_name.trim(), phone: d.phone.trim() }, emailRedirectTo: siteUrl() },
      });
      if (error) { $('#err').textContent = humanError(error); return; }
      if (data.session) {
        await onAuth();
        toast('Добро пожаловать, ' + (state.profile?.nickname || nickname) + '!', 'ok');
        location.hash = '#/tournaments';
      } else {
        render(`<div class="card auth-card"><h2>Почти готово!</h2><p>Мы отправили письмо на <b>${esc(d.email)}</b>. Перейдите по ссылке из письма, чтобы подтвердить email, и затем войдите.</p><a class="btn primary" style="margin-top:16px" href="#/login">Ко входу</a></div>`);
      }
    });
  });
}

function pageForgot({ render }) {
  render(`<form class="card auth-card form" id="fForm">
    <h2>Восстановление пароля</h2>
    <p class="muted">Укажите email — мы пришлём ссылку для установки нового пароля.</p>
    <div class="field"><label>Email</label><input name="email" type="email" required></div>
    <button class="btn primary" type="submit">Отправить ссылку</button>
    <a href="#/login">← Ко входу</a>
  </form>`);
  $('#fForm').addEventListener('submit', e => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const { error } = await sb.auth.resetPasswordForEmail(formData(e.target).email.trim(), { redirectTo: siteUrl() });
      if (error) throw error;
      render(`<div class="card auth-card"><h2>Письмо отправлено</h2><p class="muted">Проверьте почту и перейдите по ссылке из письма.</p></div>`);
    });
  });
}

function pageNewPassword({ render }) {
  render(`<form class="card auth-card form" id="npForm">
    <h2>Новый пароль</h2>
    <div class="field"><label>Новый пароль</label><input name="password" type="password" minlength="6" required autocomplete="new-password"></div>
    <button class="btn primary" type="submit">Сохранить</button>
  </form>`);
  $('#npForm').addEventListener('submit', e => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const { error } = await sb.auth.updateUser({ password: formData(e.target).password });
      if (error) throw error;
      toast('Пароль обновлён', 'ok');
      location.hash = '#/profile';
    });
  });
}

// ---------------------------------------------------------------- BOOT
async function onAuth() {
  const { data } = await sb.auth.getSession();
  state.session = data.session;
  await loadProfile();
  updateHeader();
}

async function boot() {
  $('#brandName').textContent = CLUB;
  $('#footerName').textContent = CLUB;
  $('#burger').onclick = () => $('#nav').classList.toggle('open');
  $('#overlay').addEventListener('click', e => { if (e.target.id === 'overlay') closeModal(); });
  if (!configured) { router(); return; }

  let recovery = /type=recovery/.test(location.hash);
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') recovery = true;
    const changed = (session?.user?.id || null) !== (state.user?.id || null);
    state.session = session;
    if (changed && event !== 'INITIAL_SESSION') {
      // отложенно, чтобы не блокировать колбэк supabase-js
      setTimeout(async () => { await loadProfile(); updateHeader(); if (event === 'SIGNED_OUT') router(); }, 0);
    }
  });
  await onAuth();
  if (/access_token=|error_description=/.test(location.hash)) {
    const err = new URLSearchParams(location.hash.slice(1)).get('error_description');
    history.replaceState(null, '', location.pathname + (recovery ? '#/new-password' : err ? '#/login' : '#/'));
    if (err) toast(err, 'err'); else if (!recovery && state.user) toast('Email подтверждён, добро пожаловать!', 'ok');
  }
  window.addEventListener('hashchange', router);
  router();
}
boot();
