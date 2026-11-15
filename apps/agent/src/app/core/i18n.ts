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
  },
};

export const LANGUAGES = [{ code: 'en', name: 'English' }, { code: 'ha', name: 'Hausa' }];

@Injectable({ providedIn: 'root' })
export class I18n {
  readonly lang = signal<string>(localStorage.getItem('rumfa.lang') ?? 'en');
  set(code: string) { this.lang.set(code); localStorage.setItem('rumfa.lang', code); }
  t = (s: string): string => DICT[this.lang()]?.[s] ?? s;
}
