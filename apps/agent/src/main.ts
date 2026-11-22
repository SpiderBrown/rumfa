import { bootstrapApplication } from '@angular/platform-browser';
import { Capacitor } from '@capacitor/core';
import { addIcons } from 'ionicons';
import {
  alertCircle, arrowBack, arrowForward, location, call, callOutline, camera, chatbubbles, checkmarkCircle, chevronForward, cloudUploadOutline, documentText, helpCircle, home, list, locationOutline, logOut, mail, people, personAdd, refresh, send, shieldCheckmark, speedometer, timeOutline, videocam, warning, closeCircle, phonePortrait, map, arrowUndo, flame, fileTrayFull, skull, handLeft, cash, hourglass, fingerPrint, personRemove, newspaper, cloudOffline, ellipsisHorizontalCircle, ellipseOutline, clipboard, checkmark, today, personCircle, chatbubble, lockClosed, createOutline, informationCircleOutline, cloudDoneOutline, cloudOfflineOutline, cloudDone, language, business, key, backspaceOutline, wifi, notifications, notificationsOutline, mic, micOutline, school, add, remove, image, images, trash, close, navigate, walk, ban, megaphone, headset, calendar, alarm, barChart, statsChart, pulse, checkmarkDone, chevronBack, chevronDown, chevronUp, cameraOutline, imagesOutline, documentTextOutline, alertCircleOutline, personOutline, peopleOutline, chatbubblesOutline, timerOutline, flag, helpCircleOutline, phonePortraitOutline, trendingUp, archive, cube, eyeOff, cameraReverse, flash, flashOff, stopCircle, radioButtonOn, mapOutline, homeOutline, listOutline, sync, layers, ellipsisHorizontal, sendOutline, attach, radioButtonOff, checkmarkCircleOutline, personAddOutline, locationSharp, pin, shieldOutline, sparkles, calendarOutline, reader, readerOutline, cloudDownloadOutline, downloadOutline, eye, refreshOutline, thumbsUp, thumbsDown, closeCircleOutline, caretForward,
} from 'ionicons/icons';
import { appConfig } from './app/app.config';
import { App } from './app/app';

addIcons({
  alertCircle, arrowBack, arrowForward, location, call, callOutline, camera, chatbubbles, checkmarkCircle, chevronForward, cloudUploadOutline, documentText, helpCircle, home, list, locationOutline, logOut, mail, people, personAdd, refresh, send, shieldCheckmark, speedometer, timeOutline, videocam, warning, closeCircle, phonePortrait, map, arrowUndo, flame, fileTrayFull, skull, handLeft, cash, hourglass, fingerPrint, personRemove, newspaper, cloudOffline, ellipsisHorizontalCircle, ellipseOutline, clipboard, checkmark, today, personCircle, chatbubble, lockClosed, createOutline, informationCircleOutline, cloudDoneOutline, cloudOfflineOutline, cloudDone, language, business, key, backspaceOutline, wifi, notifications, notificationsOutline, mic, micOutline, school, add, remove, image, images, trash, close, navigate, walk, ban, megaphone, headset, calendar, alarm, barChart, statsChart, pulse, checkmarkDone, chevronBack, chevronDown, chevronUp, cameraOutline, imagesOutline, documentTextOutline, alertCircleOutline, personOutline, peopleOutline, chatbubblesOutline, timerOutline, flag, helpCircleOutline, phonePortraitOutline, trendingUp, archive, cube, eyeOff, cameraReverse, flash, flashOff, stopCircle, radioButtonOn, mapOutline, homeOutline, listOutline, sync, layers, ellipsisHorizontal, sendOutline, attach, radioButtonOff, checkmarkCircleOutline, personAddOutline, locationSharp, pin, shieldOutline, sparkles, calendarOutline, reader, readerOutline, cloudDownloadOutline, downloadOutline, eye, refreshOutline, thumbsUp, thumbsDown, closeCircleOutline, caretForward,
});
bootstrapApplication(App, appConfig)
  .then(() => {
    if (!Capacitor.isNativePlatform() && 'serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/service-worker.js').catch((err) => console.error('PWA service worker registration failed', err));
    }
  })
  .catch((err) => console.error(err));
