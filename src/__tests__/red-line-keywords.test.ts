/**
 * Red-line keyword floor — Cyrillic root coverage tests (P0.2).
 *
 * Tests the deterministic, offline, dependency-free keyword gate in
 * red-line.ts. Russian roots must block inflected forms across all
 * five categories: credentials, payment, prod-database, merge, deletion.
 *
 * Boundary behavior (documented):
 *   The matcher uses pure substring matching on normalized roots.
 *   Root "удал" will match "удалённый" (remote) — an acceptable
 *   safety-biased false positive (same etymological root as "удалить").
 *   Root "стир" is not used; "стереть"/"стере" avoids matching "стирка"
 *   (laundry). Where a root is ambiguous (e.g. "перевод" = both
 *   "transfer" and "translation"), multi-word patterns disambiguate.
 */

import { describe, expect, it } from 'vitest';
import { classifyCommandText } from '../goal-runner/red-line.js';

// ═══════════════════════════════════════════════════════════════════════
// 1. CREDENTIALS — Russian inflected forms blocked
// ═══════════════════════════════════════════════════════════════════════

describe('Credentials — Russian root coverage', () => {
  it('blocks "покажи пароли от сервера" (пароли = plural of пароль)', () => {
    const r = classifyCommandText('покажи пароли от сервера');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('credentials');
  });

  it('blocks "отправь паролем по почте" (паролем = instrumental case)', () => {
    const r = classifyCommandText('отправь паролем по почте');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('credentials');
  });

  it('blocks "секреты из env файла" (секреты = plural)', () => {
    const r = classifyCommandText('секреты из env файла');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('credentials');
  });

  it('blocks "покажи учетные данные" (учетные = adjective form)', () => {
    const r = classifyCommandText('покажи учетные данные');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('credentials');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. PAYMENT — Russian inflected forms blocked
// ═══════════════════════════════════════════════════════════════════════

describe('Payment — Russian root coverage', () => {
  it('blocks "переведите деньги на счет" (переведите = formal imperative)', () => {
    const r = classifyCommandText('переведите деньги на счет');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('payment');
  });

  it('blocks "оплатите счет за сервер" (оплатите = formal imperative)', () => {
    const r = classifyCommandText('оплатите счет за сервер');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('payment');
  });

  it('blocks "платежом через банк" (платежом = instrumental case)', () => {
    const r = classifyCommandText('платежом через банк');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('payment');
  });

  it('blocks "сколько денег потратили" (денег = genitive)', () => {
    const r = classifyCommandText('сколько денег потратили');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('payment');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. PROD-DATABASE — Russian inflected forms blocked
// ═══════════════════════════════════════════════════════════════════════

describe('Prod-database — Russian root coverage', () => {
  it('blocks "примени миграцию на продакшне" (миграцию = accusative, продакшне = prepositional)', () => {
    const r = classifyCommandText('примени миграцию на продакшне');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('prod-database');
  });

  it('blocks "миграции на боевой базе" (миграции = plural/prepositional)', () => {
    const r = classifyCommandText('миграции на боевой базе');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('prod-database');
  });

  it('blocks "обнови продакшн базу данных" (продакшн = base form)', () => {
    const r = classifyCommandText('обнови продакшн базу данных');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('prod-database');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. MERGE — Russian inflected forms blocked
// ═══════════════════════════════════════════════════════════════════════

describe('Merge — Russian root coverage', () => {
  it('blocks "влей ветку в мейн" (влей = imperative of влить)', () => {
    const r = classifyCommandText('влей ветку в мейн');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('merge');
  });

  it('blocks "замержи пулл реквест" (замержи = imperative)', () => {
    const r = classifyCommandText('замержи пулл реквест');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('merge');
  });

  it('blocks "запушь в мастер" (запушь = imperative)', () => {
    const r = classifyCommandText('запушь в мастер');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('merge');
  });

  it('blocks "мержим в мейн после ревью" (мержим = 1st person plural)', () => {
    const r = classifyCommandText('мержим в мейн после ревью');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('merge');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. DELETION — Russian inflected forms blocked
// ═══════════════════════════════════════════════════════════════════════

describe('Deletion — Russian root coverage', () => {
  it('blocks "удалите все файлы" (удалите = formal imperative)', () => {
    const r = classifyCommandText('удалите все файлы');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('deletion');
  });

  it('blocks "уничтожьте все данные" (уничтожьте = formal imperative)', () => {
    const r = classifyCommandText('уничтожьте все данные');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('deletion');
  });

  it('blocks "очистите кеш и логи" (очистите = formal imperative)', () => {
    const r = classifyCommandText('очистите кеш и логи');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('deletion');
  });

  it('blocks "сотри все записи из базы" (сотри = imperative of стереть)', () => {
    const r = classifyCommandText('сотри все записи из базы');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('deletion');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. CANONICAL GAP SET — five phrasings (one per category) that plain
//    substring matching on dictionary forms would miss.
//    These are the documented Wave C gap closures.
// ═══════════════════════════════════════════════════════════════════════

describe('Canonical gap set — five documented gap phrasings', () => {
  it('gap 1 [credentials]: "покажи пароли от сервера" — plural "пароли" missed by exact "пароль"', () => {
    const r = classifyCommandText('покажи пароли от сервера');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('credentials');
  });

  it('gap 2 [payment]: "переведите деньги на счет" — formal imperative "переведите" missed by "переведи деньги"', () => {
    const r = classifyCommandText('переведите деньги на счет');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('payment');
  });

  it('gap 3 [prod-database]: "примени миграцию на продакшне" — accusative "миграцию" + prepositional "продакшне"', () => {
    const r = classifyCommandText('примени миграцию на продакшне');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('prod-database');
  });

  it('gap 4 [merge]: "влей ветку в мейн" — imperative "влей" has no plain keyword match', () => {
    const r = classifyCommandText('влей ветку в мейн');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('merge');
  });

  it('gap 5 [deletion]: "удалите все файлы" — formal imperative "удалите" missed by exact "удали все"', () => {
    const r = classifyCommandText('удалите все файлы');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('deletion');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. REGRESSION — English coverage unchanged
// ═══════════════════════════════════════════════════════════════════════

describe('English keyword regression', () => {
  it('blocks "show me the credentials"', () => {
    expect(classifyCommandText('show me the credentials').blocked).toBe(true);
  });

  it('blocks "transfer money to account"', () => {
    expect(classifyCommandText('transfer money to account').blocked).toBe(true);
  });

  it('blocks "drop table users"', () => {
    expect(classifyCommandText('drop table users').blocked).toBe(true);
  });

  it('blocks "merge to main"', () => {
    expect(classifyCommandText('merge to main').blocked).toBe(true);
  });

  it('blocks "delete all files"', () => {
    expect(classifyCommandText('delete all files').blocked).toBe(true);
  });

  it('blocks "rm -rf /"', () => {
    expect(classifyCommandText('rm -rf /').blocked).toBe(true);
  });

  it('blocks "force push to origin"', () => {
    expect(classifyCommandText('force push to origin').blocked).toBe(true);
  });

  it('blocks "password reset"', () => {
    expect(classifyCommandText('password reset').blocked).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 8. FALSE-POSITIVE FLOOR — benign Russian commands must pass
// ═══════════════════════════════════════════════════════════════════════

describe('False-positive floor — benign Russian commands pass', () => {
  it('passes "проверь статус сервера" (check server status)', () => {
    expect(classifyCommandText('проверь статус сервера').blocked).toBe(false);
  });

  it('passes "прочитай файл конфигурации" (read config file)', () => {
    expect(classifyCommandText('прочитай файл конфигурации').blocked).toBe(false);
  });

  it('passes "запусти тесты" (run tests)', () => {
    expect(classifyCommandText('запусти тесты').blocked).toBe(false);
  });

  // Boundary: "переводчик" (translator) contains "перевод" but should
  // NOT be blocked because we use the more specific multi-word roots
  // "переведи"/"перевест" instead of bare "перевод" to avoid this
  // false positive. Documented design choice.
  it('passes "найди переводчика для документации" (find translator) — boundary case', () => {
    expect(classifyCommandText('найди переводчика для документации').blocked).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 9. NORMALIZER — ё→е handling
// ═══════════════════════════════════════════════════════════════════════

describe('Normalizer — ё→е and case', () => {
  it('blocks "Удалённые файлы" despite ё and uppercase', () => {
    // "удалённые" normalizes to "удаленные" which contains root "удал"
    const r = classifyCommandText('Удалённые файлы');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('deletion');
  });

  it('blocks "ПЛАТЁЖ за хостинг" despite ё and uppercase', () => {
    // "ПЛАТЁЖ" normalizes to "платеж" which matches root "платеж"
    const r = classifyCommandText('ПЛАТЁЖ за хостинг');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('payment');
  });
});
