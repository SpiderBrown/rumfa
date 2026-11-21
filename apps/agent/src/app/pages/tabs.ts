import { Component, computed, inject } from '@angular/core';
import { IonBadge, IonIcon, IonLabel, IonTabBar, IonTabButton, IonTabs } from '@ionic/angular';
import { Api } from '../core/api';
import { Badges } from '../core/badges';
import { DayJourney } from '../core/day';
import { Tasks } from '../core/tasks';
import { DAY_STAGES } from '../core/checklist';
import { I18n } from '../core/i18n';

interface Tab { id: string; icon: string; label: string; badge?: () => number | string | null; tone?: 'progress' | 'alert' }

/**
 * The app's main sections as bottom tabs (thumb reach, one hand), different by role:
 *  - at a polling unit (agents, volunteers): Today (the day's journey) · Chats · Me
 *  - coordinators: My area · Chats (with call requests on top) · Tasks · Me
 * Everything else (report, result, live count, a chat) opens on top of the tabs.
 */
@Component({
  selector: 'page-tabs',
  imports: [IonBadge, IonIcon, IonLabel, IonTabBar, IonTabButton, IonTabs],
  template: `
  <ion-tabs>
    <ion-tab-bar slot="bottom">
      @for (tab of tabs(); track tab.id) {
        <ion-tab-button [tab]="tab.id">
          <ion-icon [name]="tab.icon" />
          <ion-label>{{ t(tab.label) }}</ion-label>
          @if (tab.badge?.(); as b) { <ion-badge [class]="tab.tone ?? 'alert'">{{ b }}</ion-badge> }
        </ion-tab-button>
      }
    </ion-tab-bar>
  </ion-tabs>`,
  styles: `
    ion-tab-bar { --border: 1px solid #e5e7eb; height: 62px; padding-bottom: env(safe-area-inset-bottom); }
    ion-tab-button { --color-selected: var(--ion-color-primary); font-size: 12px; }
    ion-tab-button ion-icon { font-size: 25px; }
    ion-badge { font-size: 11px; min-width: 18px; } ion-badge.alert { --background: #d32f2f; } ion-badge.progress { --background: #16a34a; }
  `,
})
export default class TabsPage {
  private api = inject(Api);
  private badges = inject(Badges);
  private day = inject(DayJourney);
  private tasks = inject(Tasks);
  constructor() { this.tasks.start(); }
  t = inject(I18n).t;

  tabs = computed<Tab[]>(() => {
    // Coordinators: call requests now sit at the top of Chats, so they count on that tab
    const chats: Tab = { id: 'chats', icon: 'chatbubbles', label: 'Chats', badge: () => this.count(this.badges.unread() + (this.api.isCoordinator() ? this.badges.requests() : 0)) };
    const me: Tab = { id: 'me', icon: 'person-circle', label: 'Me', badge: () => this.badges.waiting() || null };
    if (this.api.isCoordinator()) {
      return [
        { id: 'area', icon: 'map', label: 'My area' }, chats,
        { id: 'tasks', icon: 'checkmark-done', label: 'Tasks', badge: () => this.tasks.open().length || null }, me,
      ];
    }
    return [{ id: 'today', icon: 'today', label: 'Today', tone: 'progress',
      badge: () => (this.api.atUnit() ? `${this.day.doneStages()}/${DAY_STAGES.length}` : null) }, chats, me];
  });

  private count(n: number) { return n ? (n > 99 ? '99+' : n) : null; }
}
