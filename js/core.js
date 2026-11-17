// Общие помощники: клиент Supabase, текущий пользователь, форматирование, UI.
const CFG = window.BLIND_CONFIG || {};

export const configured = !!(CFG.SUPABASE_URL && CFG.SUPABASE_URL.startsWith('http') && CFG.SUPABASE_ANON_KEY && window.supabase);
export const sb = configured ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;
export const CUR = CFG.CURRENCY || '₽';
export const CLUB = CFG.CLUB_NAME || 'БЛАЙНД';

// ---------- состояние пользователя ----------
export const state = { session: null, user: null, profile: null };
export const isStaff = () => !!state.profile && !state.profile.is_banned && ['dealer', 'admin'].includes(state.profile.role);
export const isAdmin = () => !!state.profile && !state.profile.is_banned && state.profile.role === 'admin';

export async function loadProfile() {
  state.user = state.session?.user || null;
  state.profile = null;
  if (!state.user) return;
  const { data, error } = await sb.from('profiles').select('*').eq('id', state.user.id).maybeSingle();
  if (error) console.error(error);
  state.profile = data || null;
}

// ---------- запросы ----------
export async function q(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(humanError(error));
  return data;
}

export function humanError(err) {
  const m = (err && (err.message || err.error_description || String(err))) || 'Ошибка';
  if (/Invalid login credentials/i.test(m)) return 'Неверный email или пароль';
  if (/Email not confirmed/i.test(m)) return 'Email не подтверждён — откройте письмо и перейдите по ссылке';
  if (/User already registered/i.test(m)) return 'Пользователь с таким email уже зарегистрирован';
  if (/Password should be at least/i.test(m)) return 'Пароль слишком короткий (минимум 6 символов)';
  if (/profiles_nickname_uq|duplicate key.*nickname/i.test(m)) return 'Этот ник уже занят';
  if (/registrations_user_uq/i.test(m)) return 'Этот игрок уже записан на турнир';
  if (/rate limit/i.test(m)) return 'Слишком много попыток, подождите немного';
  if (/row-level security|permission denied/i.test(m)) return 'Недостаточно прав';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Нет связи с сервером';
  if (/relation .* does not exist|Could not find the (table|function)/i.test(m)) return 'База данных не настроена: выполните supabase/schema.sql в Supabase';
  return m;
}

// ---------- форматирование ----------
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (n) => (Number(n) || 0).toLocaleString('ru-RU') + ' ' + CUR;
export const num = (n) => (Number(n) || 0).toLocaleString('ru-RU');
export const pts = (n) => { const v = Number(n) || 0; return (Math.round(v * 10) / 10).toLocaleString('ru-RU'); };
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_GEN = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
export const monthName = (d) => { const s = MONTHS[d.getMonth()]; return s[0].toUpperCase() + s.slice(1) + ' ' + d.getFullYear(); };
export const fmtDate = (iso) => { const d = new Date(iso); return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}, ${WEEKDAYS[d.getDay()]}`; };
export const fmtTime = (iso) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
export const fmtDateTime = (iso) => `${fmtDate(iso)} · ${fmtTime(iso)}`;
export const dateBadge = (iso) => { const d = new Date(iso); return `<div class="date-badge"><div class="d">${d.getDate()}</div><div class="m">${MONTHS_GEN[d.getMonth()]}</div></div>`; };
export const initial = (nick) => esc((nick || '?').trim().charAt(0).toUpperCase() || '?');

export const STATUS_LABEL = { scheduled: 'Запись открыта', running: 'Идёт', finished: 'Завершён', cancelled: 'Отменён' };
export const ROLE_LABEL = { player: 'Игрок', dealer: 'Крупье', admin: 'Администратор' };
export const REG_LABEL = { registered: 'Записан', checked_in: 'Пришёл', waitlist: 'Лист ожидания' };

export function statusBadge(t) {
  if (t.status === 'scheduled' && !t.registration_open) return `<span class="badge closed">Запись закрыта</span>`;
  return `<span class="badge ${t.status}">${STATUS_LABEL[t.status] || t.status}</span>`;
}
export const roleBadge = (r) => `<span class="badge ${r}">${ROLE_LABEL[r] || r}</span>`;
export function placeHtml(p) {
  if (!p) return '<span class="muted">—</span>';
  return `<span class="place ${p <= 3 ? 'p' + p : ''}">${p}</span>`;
}
export const playerName = (r) => r.profiles?.nickname || r.guest_name || 'Игрок';
export function playerLink(r) {
  if (r.user_id) return `<a href="#/player/${r.user_id}">${esc(playerName(r))}</a>`;
  return `${esc(r.guest_name)} <span class="muted small">(гость)</span>`;
}

// ---------- UI ----------
export function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 5000 : 3000);
}
export const toastErr = (e) => toast(humanError(e), 'err');

const overlay = () => document.getElementById('overlay');
export function closeModal() { overlay().classList.remove('open'); }
export function openModal(html, onMount) {
  document.getElementById('modal').innerHTML = html;
  overlay().classList.add('open');
  onMount && onMount(document.getElementById('modal'));
}
export function confirmDialog(title, text, okLabel = 'Да', danger = false) {
  return new Promise(resolve => {
    openModal(`<h3>${esc(title)}</h3><p>${esc(text)}</p>
      <div class="btn-row"><button class="btn" data-a="no">Отмена</button><button class="btn ${danger ? 'danger' : 'primary'}" data-a="yes">${esc(okLabel)}</button></div>`,
      m => {
        m.querySelector('[data-a=no]').onclick = () => { closeModal(); resolve(false); };
        m.querySelector('[data-a=yes]').onclick = () => { closeModal(); resolve(true); };
      });
  });
}

// Блокирует кнопку на время асинхронного действия
export async function busy(btn, fn) {
  if (btn) { btn.disabled = true; btn.dataset.label = btn.innerHTML; btn.innerHTML = '…'; }
  try { return await fn(); }
  catch (e) { toastErr(e); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = btn.dataset.label; } }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const formData = (form) => Object.fromEntries(new FormData(form).entries());

// Начало месяца / следующего месяца в локальном времени
export function monthRange(year, month) {
  return [new Date(year, month, 1), new Date(year, month + 1, 1)];
}

// Карточка турнира для списков
export function tournamentCard(t, myStatus) {
  const taken = t.seats_taken || 0;
  const pct = Math.min(100, Math.round(taken / Math.max(1, t.max_players) * 100));
  const full = taken >= t.max_players;
  const me = myStatus ? `<span class="badge ${myStatus === 'waitlist' ? 'wait' : 'me'}">${myStatus === 'waitlist' ? 'Вы в листе ожидания' : 'Вы записаны'}</span>` : '';
  return `<a class="t-card" href="#/t/${t.id}">
    <div class="t-top">${dateBadge(t.starts_at)}
      <div style="flex:1; min-width:0;">
        <div class="t-title">${esc(t.title)}</div>
        <div class="t-meta">${fmtTime(t.starts_at)}${t.location ? ' · ' + esc(t.location) : ''}</div>
      </div>
    </div>
    <div class="btn-row" style="gap:6px;">${statusBadge(t)} ${me} ${t.is_rating ? '' : '<span class="badge closed">Вне рейтинга</span>'}</div>
    <div class="t-facts"><span>Взнос <b>${money(t.buy_in)}</b></span><span>Стек <b>${num(t.starting_stack)}</b></span></div>
    ${t.status === 'scheduled' || t.status === 'running' ? `<div class="seats">
      <div class="bar ${full ? 'full' : ''}"><span style="width:${pct}%"></span></div>
      <div class="txt"><span>Мест занято: <b style="color:var(--cream)">${taken} / ${t.max_players}</b></span><span>${full ? (t.waitlist_count ? 'ожидают: ' + t.waitlist_count : 'мест нет') : 'свободно: ' + (t.max_players - taken)}</span></div>
    </div>` : ''}
  </a>`;
}
