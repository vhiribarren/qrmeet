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

  // Small talk — easy, low-stakes openers
  'Coffee, tea, or something else to start your day?',
  'Are you more of a beach holiday or a mountain getaway person?',
  'What is the best thing you have eaten this week?',
  'What is the weather like where you are from?',
  'Do you have any plans for the weekend?',
  'Early bird or night owl?',
  'What is your favourite way to spend a rainy day?',
  'Sweet or savoury for breakfast?',
  'What is your go-to comfort food?',
  'Do you prefer texting or calling?',
  'What is the last show you binge-watched?',
  'Cats, dogs, or neither?',
  'What is your favourite season and why?',
  'What is the best meal you have had recently?',
  'Do you have a favourite local spot for coffee or food?',
  'How do you usually unwind after a long day?',
  'What is something small that made you smile today?',
  'Are you a planner or more spontaneous?',
  'What is your favourite way to spend a Sunday?',
  'What is the last photo you took on your phone?',

  // Culture & discovery — travel, traditions, perspectives
  'What is a tradition from your culture that you love?',
  'What is the most beautiful place you have ever visited?',
  'What is a dish from your country everyone should try?',
  'What language would you love to learn and why?',
  'What is the most memorable trip you have ever taken?',
  'Is there a place on your bucket list you are dying to visit?',
  'What is a custom from another country that fascinates you?',
  'What is your favourite holiday or festival to celebrate?',
  'What is a book or film that opened your eyes to another culture?',
  'If you could live in any country for a year, where would it be?',
  'What is a local saying or expression from where you grew up?',
  'What is the best street food you have ever tried?',
  'What is something tourists always get wrong about your hometown?',
  'What is a piece of music that reminds you of home?',
  'What is the most surprising thing you learned while travelling?',
  'What is a tradition you would love to start one day?',
  'What is your favourite museum, landmark, or hidden gem?',
  'What country has the food you could eat every day?',
  'What is a word in another language that has no English equivalent?',
  'If you could time-travel to any era, which would you visit?',
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
