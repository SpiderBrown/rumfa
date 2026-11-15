import { Component, ElementRef, OnDestroy, computed, inject, signal, viewChild } from '@angular/core';
import { PercentPipe } from '@angular/common';
import { IonBackButton, IonButtons, IonContent, IonHeader, IonItem, IonLabel, IonList, IonListHeader, IonSegment, IonSegmentButton, IonTitle, IonToolbar } from '@ionic/angular';
import { ISSUE_BANDS, REPORTING_BANDS, issueBand, issueScore, partyColour, reportingBand, type MapLayer } from '@rumfa/shared';
import { Api } from '../core/api';
import { AreaMap, type MapArea, type MapData } from '../core/area-map';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';

/**
 * Coordinator's map: the sub-areas under me (wards, or polling units for a ward coordinator) coloured by
 * open issues, the leading party or reporting. Tap an area to go down a level.
 */
@Component({
  selector: 'page-coord-map',
  imports: [PercentPipe, IonBackButton, IonButtons, IonContent, IonHeader, IonItem, IonLabel, IonList, IonListHeader, IonSegment,
    IonSegmentButton, IonTitle, IonToolbar],
  template: `
  <ion-header>
    <ion-toolbar color="primary"><ion-buttons slot="start"><ion-back-button defaultHref="/" /></ion-buttons>
      <ion-title>{{ t('My area map') }}</ion-title></ion-toolbar>
    <ion-toolbar>
      <ion-segment [value]="layer()" (ionChange)="setLayer($any($event.detail.value))">
        <ion-segment-button value="issues">{{ t('Issues') }}</ion-segment-button>
        <ion-segment-button value="votes">{{ t('Votes') }}</ion-segment-button>
        <ion-segment-button value="reporting">{{ t('Reporting') }}</ion-segment-button>
      </ion-segment>
    </ion-toolbar>
  </ion-header>
  <ion-content>
    <div class="crumbs">
      @for (b of data()?.breadcrumb ?? []; track b.code; let last = $last) {
        @if (last) { <b>{{ b.name }}</b> } @else { <a (click)="open(b.code)">{{ b.name }}</a> › }
      }
    </div>
    <div class="mapwrap">
      <div #map class="map"></div>
      <div class="legend">
        @switch (layer()) {
          @case ('issues') { @for (b of issueBands; track b.label) { <span><i [style.background]="b.colour"></i>{{ t(b.label) }}</span> } }
          @case ('votes') { @for (p of partiesShown(); track p) { <span><i [style.background]="colour(p)"></i>{{ p }}</span> } }
          @case ('reporting') { @for (b of reportingBands; track b.label) { <span><i [style.background]="b.colour"></i>{{ b.label }}</span> } }
        }
      </div>
    </div>
    @if (data(); as d) {
      <div class="sum">
        <div><b>{{ totals().reported }}/{{ totals().units }}</b><span>{{ t('reported') }}</span></div>
        <div [class.bad]="totals().open"><b>{{ totals().open }}</b><span>{{ t('open issues') }}</span></div>
        <div [class.bad]="totals().critical"><b>{{ totals().critical }}</b><span>{{ t('critical') }}</span></div>
      </div>
      <ion-list>
        <ion-list-header>{{ d.children.length }} {{ t(childName()) }}</ion-list-header>
        @for (a of sorted(); track a.code) {
          <ion-item [button]="d.childLevel !== 'pu'" (click)="tap(a)">
            <span slot="start" class="dot" [style.background]="dot(a)"></span>
            <ion-label>
              <h2>{{ a.name }}</h2>
              <p>
                @if (a.open) { {{ a.open }} {{ t('open') }}@if (a.critical) { ({{ a.critical }} {{ t('critical') }}) } · }
                @if (a.leader) { {{ a.leader.party }} {{ a.leader.share | percent }} · }
                {{ a.reported }}/{{ d.childLevel === 'pu' ? 1 : a.units }} {{ t('reported') }} · {{ a.agents }} {{ t(a.agents === 1 ? 'agent' : 'agents') }}
              </p>
              @if (a.coordinator) { <p>{{ t('Coordinator') }}: {{ a.coordinator.full_name }}</p> }
            </ion-label>
          </ion-item>
        }
      </ion-list>
    }
  </ion-content>`,
  styles: `.crumbs { padding: 8px 12px; font-size: 14px; } .crumbs a { color: var(--ion-color-primary); }
    .mapwrap { position: relative; } .map { height: 52vh; background: #eef1f4; }
    .legend { position: absolute; left: 8px; bottom: 8px; z-index: 500; background: #fff; padding: 6px 8px; border-radius: 8px; font-size: 11px;
      box-shadow: 0 1px 4px rgba(0,0,0,.25); display: flex; flex-direction: column; gap: 2px; max-height: 45%; overflow: auto; }
    .legend span { display: flex; align-items: center; gap: 5px; } .legend i { width: 12px; height: 12px; border-radius: 3px; border: 1px solid rgba(0,0,0,.2); }
    .sum { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; padding: 8px 12px; }
    .sum div { background: var(--ion-color-light); border-radius: 10px; padding: 6px; text-align: center; }
    .sum b { display: block; font-size: 18px; } .sum span { font-size: 11px; color: var(--ion-color-medium); } .sum .bad b { color: var(--ion-color-danger); }
    .dot { width: 14px; height: 14px; border-radius: 4px; border: 1px solid rgba(0,0,0,.2); }`,
})
export default class CoordMapPage implements OnDestroy {
  private api = inject(Api);
  private ui = inject(Ui);
  private i18n = inject(I18n);
  t = this.i18n.t;
  private el = viewChild.required<ElementRef<HTMLElement>>('map');
  private areaMap: AreaMap | null = null;
  private stopLive: () => void = () => undefined;
  private reloadTimer: any;
  private parent: string | null = null;

  readonly issueBands = ISSUE_BANDS;
  readonly reportingBands = REPORTING_BANDS.map((colour, i) => ({ colour, label: ['0%', '<25%', '25–50%', '50–90%', '90%+'][i] }));
  data = signal<MapData | null>(null);
  layer = signal<MapLayer>('issues');
  childName = computed(() => ({ state: 'States', lga: 'LGAs', ward: 'Wards', pu: 'Polling units' } as Record<string, string>)[this.data()?.childLevel ?? 'ward']);
  totals = computed(() => {
    const d = this.data();
    const t = { units: 0, reported: 0, open: d?.areaWide.open ?? 0, critical: d?.areaWide.critical ?? 0 };
    for (const c of d?.children ?? []) { t.units += d!.childLevel === 'pu' ? 1 : c.units; t.reported += c.reported; t.open += c.open; t.critical += c.critical; }
    return t;
  });
  partiesShown = computed(() => {
    const leading = new Set((this.data()?.children ?? []).map((c) => c.leader?.party).filter(Boolean) as string[]);
    return leading.size ? [...leading] : (this.data()?.parties ?? []).slice(0, 5);
  });
  sorted = computed(() => {
    const kids = [...(this.data()?.children ?? [])];
    return this.layer() === 'issues' ? kids.sort((a, b) => issueScore(b) - issueScore(a)) : kids;
  });

  /** Ionic shows the page after an animation; the map needs its final size first. */
  ionViewDidEnter() {
    if (!this.areaMap) {
      this.areaMap = new AreaMap(this.el().nativeElement, window.RUMFA_CONFIG.mapTiles);
      void this.load();
      this.stopLive = this.api.onChange(() => { clearTimeout(this.reloadTimer); this.reloadTimer = setTimeout(() => void this.load(), 3000); }, ['cases', 'verifications']);
    } else this.areaMap.resize();
  }
  ngOnDestroy() { this.stopLive(); clearTimeout(this.reloadTimer); this.areaMap?.destroy(); }

  async load() {
    try {
      const d = await this.api.get<MapData>('/map', { parent: this.parent ?? undefined });
      this.data.set(d);
      this.parent = d.parent;
      this.draw();
    } catch (e) { await this.ui.error(e); }
  }

  open(code: string) { this.parent = code; void this.load(); }
  tap(a: MapArea) { if (this.data()?.childLevel !== 'pu') this.open(a.code); }
  setLayer(l: MapLayer) { this.layer.set(l); this.draw(); }
  colour(p: string) { const d = this.data(); return partyColour(p, d?.parties ?? [], d?.partyColours ?? {}); }
  dot(a: MapArea) {
    const d = this.data();
    const l = this.layer();
    if (l === 'issues') return ISSUE_BANDS[issueBand(a)].colour;
    if (l === 'votes') return a.leader ? this.colour(a.leader.party) : '#c9ced6';
    return REPORTING_BANDS[reportingBand(a.reported, d?.childLevel === 'pu' ? 1 : a.units)];
  }
  private draw() { const d = this.data(); if (d && this.areaMap) this.areaMap.render(d, this.layer(), (a) => this.tap(a)); }
}
