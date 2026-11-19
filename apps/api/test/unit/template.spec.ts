import { renderTemplate } from '../../src/engine/template';

describe('renderTemplate', () => {
  const ctx = {
    input: { user: { name: 'Ada' }, n: 3 },
    steps: { fetch: { status: 200 } },
  };

  it('substitutes nested paths', () => {
    expect(renderTemplate('Hi {{ input.user.name }}!', ctx)).toBe('Hi Ada!');
  });

  it('renders missing values as empty string', () => {
    expect(renderTemplate('[{{ input.nope }}]', ctx)).toBe('[]');
  });

  it('reads only properties supplied by the current input', () => {
    const input = Object.create({ label: 'outer' }) as Record<string, unknown>;
    input.name = 'Ada';
    expect(
      renderTemplate('{{ input.name }}[{{ input.label }}]', {
        input,
        steps: {},
      }),
    ).toBe('Ada[]');
  });

  it('serialises objects as JSON', () => {
    expect(renderTemplate('{{ input.user }}', ctx)).toBe('{"name":"Ada"}');
  });

  it('does not evaluate expressions', () => {
    expect(renderTemplate('{{ input.n + 1 }}', ctx)).toBe('{{ input.n + 1 }}');
  });
});
