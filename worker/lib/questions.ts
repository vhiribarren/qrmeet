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
  'Do you think a hippo would beat a rhino in a fight?',
  'If you had one superpower, what would it be and how would you misuse it?',
  'What is the weirdest food combination you secretly enjoy?',
  'If animals could talk, which one would be the rudest?',
  'What is the most useless talent you are oddly proud of?',
  'If you were a kitchen appliance, which one would you be?',
  'What fictional world would you most want to live in?',
  'Would you rather fight one horse-sized duck or a hundred duck-sized horses?',
  'What is the worst haircut you have ever had?',
  'If you had to eat one meal for the rest of your life, what would it be?',
  'What is a conspiracy theory you find weirdly entertaining?',
  'If you could instantly master any instrument, which would you pick?',
  'What is the most embarrassing song on your playlist right now?',
  'If you were stuck in an elevator, who would you want stuck with you?',
  'What is the strangest dream you actually remember?',
  'Cereal first or milk first, and are you ready to defend it?',
  'If you could rename yourself, what name would you choose?',
  'What would your villain origin story be?',
  'If you could teleport anywhere right now, where would you go?',
  'What is the most overrated movie everyone seems to love?',
  'If you had a warning label, what would it say?',
  'What is your go-to karaoke song, no matter the consequences?',
  'Would you rather be able to fly or be invisible?',
  'What is the silliest thing you have ever cried about?',
  'If you could have dinner with any historical figure, who and why?',
  'What is the most ridiculous purchase you have ever made?',
  'If your life had a theme song, what would it be?',
  'What is a small thing that makes you irrationally happy?',
  'If you could swap lives with any animal for a day, which one?',
  'What is the weirdest thing you believed as a kid?',
  'If you could uninvent one thing, what would it be?',
  'What is your most controversial pizza topping opinion?',
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
