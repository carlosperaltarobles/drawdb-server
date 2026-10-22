import { describe, expect, it } from 'vitest';
import { isAllowedDomain } from '../../src/auth/domain';

describe('isAllowedDomain', () => {
  const allowed = ['corre-dominio.com'];

  it('acepta el dominio exacto, ignorando mayúsculas y espacios', () => {
    expect(isAllowedDomain('a@corre-dominio.com', allowed)).toBe(true);
    expect(isAllowedDomain(' A@CORRE-DOMINIO.COM ', allowed)).toBe(true);
  });

  it('rechaza dominios parecidos, subdominios y textos sin @', () => {
    expect(isAllowedDomain('a@evil-corre-dominio.com', allowed)).toBe(false);
    expect(isAllowedDomain('a@corre-dominio.com.evil.io', allowed)).toBe(false);
    expect(isAllowedDomain('a@sub.corre-dominio.com', allowed)).toBe(false);
    expect(isAllowedDomain('nada', allowed)).toBe(false);
  });

  it('con la lista vacía nadie está permitido', () => {
    expect(isAllowedDomain('a@corre-dominio.com', [])).toBe(false);
  });

  it('acepta cualquiera de varios dominios', () => {
    expect(isAllowedDomain('x@b.com', ['a.com', 'b.com'])).toBe(true);
  });
});
