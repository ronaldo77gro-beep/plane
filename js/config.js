// ====== НАСТРОЙКИ САЙТА БЛАИНД ======
// Данные из Supabase: Project Settings → API (Project URL и Publishable key).
// Это публичные значения, их можно хранить в коде: доступ к данным защищён в базе (функция bl_api).
// Пароли и коды сюда НЕ пишите.
window.BLIND_CONFIG = {
  SUPABASE_URL: 'https://vebevljzhxcfqjgdanus.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_-tYg9qkHVOeT0PqPq2fMFg_2umpx7if',

  // Реквизиты оператора персональных данных — показываются в политике (privacy.html)
  // и в согласии (consent.html). Заполните своими данными ИП.
  OPERATOR: {
    name: '',          // например: 'Индивидуальный предприниматель Иванов Иван Иванович'
    inn: '',           // ИНН, 12 цифр
    ogrnip: '',        // ОГРНИП, 15 цифр
    address: '',       // адрес регистрации ИП (можно оставить пустым — тогда показывается адрес клуба)
    email: '',         // почта для обращений по персональным данным
    telegram: '@Poker_Brn',
    policyDate: '',    // дата редакции политики, например '17.11.2026'
  },
};
