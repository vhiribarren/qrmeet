import { describe, it, expect } from 'vitest'
import { pickTwoQuestions } from '../../worker/lib/questions'

describe('pickTwoQuestions', () => {
  it('returns two empty strings for an empty pool', () => {
    expect(pickTwoQuestions([])).toEqual(['', ''])
  })

  it('duplicates the only question when the pool has one', () => {
    expect(pickTwoQuestions([{ text: 'a' }])).toEqual(['a', 'a'])
  })

  it('returns two distinct questions from the pool', () => {
    const qs = [{ text: 'a' }, { text: 'b' }, { text: 'c' }]
    for (let i = 0; i < 50; i++) {
      const [x, y] = pickTwoQuestions(qs)
      expect(x).not.toBe(y)
      expect(qs.map(q => q.text)).toContain(x)
      expect(qs.map(q => q.text)).toContain(y)
    }
  })
})
