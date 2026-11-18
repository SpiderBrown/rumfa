import { estimate } from './map.controller';

describe('election day estimate', () => {
  it('scales what is known up to every unit', () => {
    expect(estimate({ APC: 300 }, { APC: 100, PDP: 50 }, 10, 4)).toEqual({ APC: 1000, PDP: 125 });
  });
  it('is empty with nothing known, and never scales down', () => {
    expect(estimate({}, {}, 10, 0)).toEqual({});
    expect(estimate({ APC: 10 }, {}, 1, 3)).toEqual({ APC: 10 });
  });
});
