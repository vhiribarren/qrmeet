/**
 * MIT License
 *
 * Copyright (c) 2026 Vincent Hiribarren
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Default questions seeded into every new room. The organiser can delete or
// add questions freely — there is no distinction between "default" and "custom"
// once the room is created.
export const DEFAULT_QUESTIONS: string[] = [
  'What does a typical day look like in your role?',
  'What is the biggest challenge you are working on right now?',
  'What is something you are particularly proud of recently?',
  'What is the last thing you learned that surprised you?',
  'What do you do outside of work that keeps you energised?',
  'What advice would you give your younger self?',
  'What book, podcast, or resource would you recommend right now?',
  'What skill are you currently trying to develop?',
  'How do you prefer to collaborate with others?',
  'If you could change one thing about your industry, what would it be?',
  'What is one goal you are focused on for the next few months?',
  'What do people usually come to you for help with?',
  'Are you a morning person or a night owl, and does it match your job?',
  'How has remote or hybrid work changed the way you work?',
  'What is a failure that turned into a valuable lesson?',
  'Who or what has inspired you most in your career?',
  'What tools or habits make you most productive?',
  'Where do you see your field heading in the next five years?',
  'What made you want to come to this event?',
  'What kind of connections are you hoping to make today?',
]

/**
 * Returns two distinct random question texts from the list.
 * If fewer than 2 questions exist, the same text may be returned for both.
 */
export function pickTwoQuestions(questions: { text: string }[]): [string, string] {
  if (questions.length === 0) return ['', '']
  if (questions.length === 1) return [questions[0].text, questions[0].text]

  const idxA = Math.floor(Math.random() * questions.length)
  let idxB = Math.floor(Math.random() * (questions.length - 1))
  if (idxB >= idxA) idxB++

  return [questions[idxA].text, questions[idxB].text]
}
