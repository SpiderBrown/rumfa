import { Injectable, signal } from '@angular/core';

// English is the default; people can switch language on the first screen or in Help.
// Hausa strings should be reviewed by a native speaker before release.
const DICT: Record<string, Record<string, string>> = {
  en: {},
  ha: {
    'Sign in': 'Shiga', 'Phone number': 'Lambar waya', 'Send code': 'Aika lamba', 'Enter the code we sent by SMS': 'Shigar da lambar da muka aiko ta SMS',
    'Create a 6-digit PIN': 'Ƙirƙiri PIN mai lamba 6', 'Repeat the PIN': 'Maimaita PIN',
    'Send code by WhatsApp': 'Aika lamba ta WhatsApp', 'I have an activation code': 'Ina da lambar kunnawa',
    'Enter the activation code from your coordinator': 'Shigar da lambar kunnawa daga mai kula da kai', 'Code': 'Lamba',
    'You will use this PIN every time you open the app.': 'Za ka yi amfani da wannan PIN duk lokacin da ka buɗe manhajar.',
    'Use another number': 'Yi amfani da wata lamba', 'Forgot PIN? Activate this phone again': 'Ka manta PIN? Sake kunna wannan waya',
    'Which organisation are you working for?': 'Wace ƙungiya kake yi wa aiki?', 'Switch organisation': 'Canja ƙungiya', 'Enter your PIN': 'Shigar da PIN ɗinka', 'Continue': 'Ci gaba',
    'Today': 'Yau', 'Check in': 'Shiga rumfa', 'Checklist': 'Jerin abubuwa', 'Report a problem': 'Bayar da rahoton matsala',
    'SOS': 'Gaggawa', 'Quick count': 'Ƙidaya cikin sauri', 'Submit result (EC8A)': 'Aika sakamako (EC8A)',
    'Ask my coordinator to call me': 'A ce mai kula ya kira ni', 'Messages': 'Saƙonni', 'Help': 'Taimako',
    'Waiting to send': 'Ana jira a aika', 'Sent': 'An aika', 'Send by SMS': 'Aika ta SMS', 'No internet': 'Babu intanet',
    'Take photo of signed sheet': 'Ɗauki hoton takardar da aka sa hannu', 'Check and submit': 'Duba ka aika', 'Submit': 'Aika',
    'Next': 'Gaba', 'Back': 'Baya', 'Yes': 'Eh', 'No': "A'a", 'Cancel': 'Soke', 'Save': 'Ajiye',
    'Your coordinator will call you': 'Mai kula zai kira ka', 'Callback requests': 'Buƙatun kira', 'Call': 'Kira',
    'My team': 'Tawagata', 'Add authority contact': 'Ƙara lambar hukuma', 'Language': 'Harshe',
    'Registered voters': 'Masu rajista', 'Accredited voters': 'Waɗanda aka tantance', 'Rejected ballots': 'Ƙuri’un da aka ƙi',
    'Total valid votes': 'Jimillar ƙuri’u masu inganci', 'Votes': "Ƙuri'u",
    'Incoming call': 'Kira mai shigowa', 'Calling': 'Ana kiran', 'On a call with': 'Ana magana da', 'Answer': 'Amsa', 'Decline': "Ƙi",
    'Hang up': 'Kashe kira', 'Mute': 'Rufe murya', 'Unmute': 'Buɗe murya',
    'Live count': 'Ƙidaya kai tsaye', 'ballots called': "ƙuri'un da aka kira", 'Unit': 'Rumfa', 'Invalid': 'Marar inganci', 'Undo': 'Soke na ƙarshe',
    'Correct': 'Gyara', 'Finish': 'Kammala', 'Done': 'Shi ke nan', 'Live': 'Kai tsaye', 'Sending…': 'Ana aikawa…', 'Total': 'Jimilla',
    'Saved on phone · waiting for signal': 'An ajiye a waya · ana jiran sabis', 'Reopen to correct': 'Buɗe don gyara', 'Loading…': 'Ana lodawa…',
    'When the INEC official calls out a ballot, tap that party. Tap Invalid for a rejected ballot.': "Idan jami'in INEC ya kira ƙuri'a, danna jam'iyyar. Danna Marar inganci don ƙuri'ar da aka ƙi.",
    'Correct a number if you missed calls or started late.': 'Gyara lamba idan ka rasa wasu kira ko ka fara a makare.',
    'Sorting finished. These totals were sent. Submit the signed EC8A result when it is ready.': 'An gama rarrabawa. An aika waɗannan jimilla. Aika sakamakon EC8A da aka sa hannu idan ya shirya.',
    'My area map': 'Taswirar yankina', 'Issues': 'Matsaloli', 'Reporting': 'Rahotanni', 'reported': 'sun aiko', 'open issues': 'matsalolin da ke buɗe',
    'critical': 'mai tsanani', 'open': 'a buɗe', 'agents': 'wakilai', 'agent': 'wakili', 'Coordinator': 'Mai kula', 'Wards': 'Gundumomi', 'Polling units': 'Rumfunan zaɓe',
    'LGAs': 'Ƙananan hukumomi', 'No open issues': 'Babu matsala a buɗe', 'Minor': "Ƙarami", 'Several': 'Da yawa', 'Serious': 'Mai muni', 'Critical open': 'Mai tsanani a buɗe',
    'Checked in': 'An shiga rumfa', 'at': 'da', 'Opens': 'Zai buɗe', 'Open now': 'A buɗe yanzu', 'Not yet': 'Ba tukuna',
    'Check-in opens at': 'Shiga rumfa zai buɗe da', 'on election day. Check in when you reach your polling unit.': 'a ranar zaɓe. Ka shiga idan ka isa rumfarka.',
    'Check-in has closed': 'An rufe shiga rumfa', 'Check-in is closed for this election.': 'An rufe shiga rumfa na wannan zaɓe.',
    'Check in again?': 'Sake shiga rumfa?', 'You checked in at': 'Ka shiga rumfa da',
    'Only check in again if you left and came back, or your unit moved to a new place.': 'Ka sake shiga kawai idan ka bar wurin ka dawo, ko an mayar da rumfarka wani wuri.',
    'Check in now?': 'Shiga rumfa yanzu?', 'Only check in when you are at your polling unit': 'Ka shiga kawai idan kana rumfarka',
    'The situation room sees the time and your location.': 'Ɗakin sa ido zai ga lokacin da wurin da kake.', 'I am here': 'Ina nan',
    'Check in again': 'Sake shiga', 'OK': 'To',
    'All done': 'An gama duka', 'done': 'an gama', 'left': 'ya rage', 'problem': 'matsala', 'problems': 'matsaloli', 'To do': 'Ba a yi ba', 'Problem': 'Matsala',
    'Opening': 'Buɗewa', 'Voting': 'Kaɗa ƙuri’a', 'Closing': 'Rufewa', 'Type the number': 'Rubuta lambar',
    'Problem noted. Report it if you have not already.': 'An lura da matsala. Ka bayar da rahoto idan baka yi ba tukuna.',
    'Answers save on this phone at once and send when there is internet. You can change an answer any time.': 'Amsoshi suna ajiyewa a waya nan take kuma za a aika idan akwai intanet. Kana iya canja amsa kowane lokaci.',
    'Report this problem?': 'A bayar da rahoton wannan matsala?', 'Report': 'Rahoto', 'Not now': 'Ba yanzu ba', 'Our party': 'Jam’iyyarmu',
    'Checked in outside your area': 'An shiga a wajen yankinka', 'Tap to check in again from your area': 'Danna don sake shiga daga yankinka',
    'Check in first': 'Fara shiga rumfa', 'Check in now': 'Shiga yanzu',
    'Check in at your polling unit before you start. It tells the situation room you are in place.': 'Ka shiga rumfa kafin ka fara. Hakan yana nuna wa ɗakin sa ido cewa kana wurin.',
    'Your last check-in was outside your area. Check in again now that you are there. The earlier one is kept.': 'Shigarka ta ƙarshe a wajen yankinka ce. Ka sake shiga yanzu da ka isa. Za a ajiye ta farko.',
    'No location': 'Babu wuri', 'We could not get your location. Turn on location and try again, or check in now and say why.': 'Ba mu sami wurinka ba. Kunna wuri ka sake gwadawa, ko ka shiga yanzu ka faɗi dalili.',
    'Reason': 'Dalili', 'Check in anyway': 'Shiga duk da haka', 'Outside your area': 'A wajen yankinka', 'Please write a short reason': 'Rubuta taƙaitaccen dalili',
    'You seem to be outside': 'Da alama kana wajen', 'about': 'kusan', 'from it': 'daga can',
    'You can still check in, but tell the situation room why (for example, the unit was moved).': 'Kana iya shiga, amma ka faɗa wa ɗakin sa ido dalili (misali, an mayar da rumfa).',
    'your ward': 'gundumarka', 'your polling unit': 'rumfarka', 'your LGA': 'ƙaramar hukumarka', 'your state': 'jiharka',
    'Checked in outside your area. Check in again when you get there.': 'An shiga a wajen yankinka. Ka sake shiga idan ka isa.',
    'Sending your request…': 'Ana aika buƙatarka…', 'asked': 'an nema',
    'It will go as soon as there is internet. You can also send it by SMS from the home screen.': 'Za ta tafi da zarar akwai intanet. Kana iya aika ta SMS daga shafin farko.',
    'Ask for a call?': 'A nemi kira?', 'Your coordinator will call you about': 'Mai kula zai kira ka game da', 'Send request': 'Aika buƙata',
    '{place} ward team': 'Tawagar gundumar {place}', '{place} LGA team': 'Tawagar ƙaramar hukumar {place}', '{place} State team': 'Tawagar jihar {place}',
    '{place} team': 'Tawagar {place}', 'Teams': 'Tawagogi', 'Cases and direct': 'Matsaloli da saƙonnin kai tsaye', 'No conversations yet.': 'Babu tattaunawa tukuna.',
    'No messages yet': 'Babu saƙo tukuna', 'You': 'Kai', 'Photo': 'Hoto', 'Voice note': 'Saƙon murya', 'Video': 'Bidiyo', 'Yesterday': 'Jiya',
    'Open': 'A buɗe', 'Closed': 'An rufe', 'Agent': 'Wakili', 'Volunteer': "Mai sa kai", 'Situation room': 'Ɗakin sa ido',
    'Situation room supervisor': 'Shugaban ɗakin sa ido', 'Legal desk': "Sashen shari'a", 'Security desk': 'Sashen tsaro', 'Administrator': 'Mai gudanarwa',
  },
};

export const LANGUAGES = [{ code: 'en', name: 'English' }, { code: 'ha', name: 'Hausa' }];

@Injectable({ providedIn: 'root' })
export class I18n {
  readonly lang = signal<string>(localStorage.getItem('rumfa.lang') ?? 'en');
  set(code: string) { this.lang.set(code); localStorage.setItem('rumfa.lang', code); }
  t = (s: string): string => DICT[this.lang()]?.[s] ?? s;
}
