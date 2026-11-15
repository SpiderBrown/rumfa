import { bootstrapApplication } from '@angular/platform-browser';
import { addIcons } from 'ionicons';
import {
  alertCircle, arrowBack, call, callOutline, camera, chatbubbles, checkmarkCircle, chevronForward, cloudUploadOutline, documentText,
  helpCircle, home, list, locationOutline, logOut, mail, people, personAdd, refresh, send, shieldCheckmark, speedometer,
  timeOutline, videocam, warning, closeCircle, phonePortrait, map, arrowUndo,
} from 'ionicons/icons';
import { appConfig } from './app/app.config';
import { App } from './app/app';

addIcons({
  alertCircle, arrowBack, call, callOutline, camera, chatbubbles, checkmarkCircle, chevronForward, cloudUploadOutline, documentText,
  helpCircle, home, list, locationOutline, logOut, mail, people, personAdd, refresh, send, shieldCheckmark, speedometer,
  timeOutline, videocam, warning, closeCircle, phonePortrait, map, arrowUndo,
});
bootstrapApplication(App, appConfig).catch((err) => console.error(err));
