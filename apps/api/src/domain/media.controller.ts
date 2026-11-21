import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Min } from 'class-validator';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { CurrentUser, Public } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { StorageService, type Bucket } from '../common/storage.service';
import { ROOM } from './roles';

const KINDS: Record<string, { bucket: Bucket; roles?: string[]; ext: string[] }> = {
  ec8a: { bucket: 'ec8a', roles: ['agent', 'coordinator'], ext: ['jpg', 'jpeg', 'png', 'webp'] },
  incident: { bucket: 'incident-media', ext: ['jpg', 'jpeg', 'png', 'webp', 'mp4', 'webm', 'm4a', 'ogg', 'aac'] },
  voice_note: { bucket: 'voice-notes', ext: ['m4a', 'ogg', 'webm', 'aac', 'mp3', 'wav'] },
  chat: { bucket: 'chat-media', ext: ['jpg', 'jpeg', 'png', 'webp', 'm4a', 'ogg', 'webm', 'aac', 'mp4'] },
  live_clip: { bucket: 'live-clips', roles: ['agent', 'volunteer', 'coordinator'], ext: ['mp4', 'webm'] },
  voice_recording: { bucket: 'voice-recordings', roles: ['voice_ops', 'admin'], ext: ['mp3', 'wav', 'm4a', 'ogg'] },
  voice_consent: { bucket: 'voice-recordings', roles: ['voice_ops', 'admin'], ext: ['pdf', 'jpg', 'jpeg', 'png'] },
  contact_import: { bucket: 'contact-imports', roles: ['admin'], ext: ['csv', 'xlsx'] },
};

class UploadDto {
  @ApiProperty({ enum: Object.keys(KINDS) }) @IsIn(Object.keys(KINDS)) kind: string;
  @ApiProperty({ example: 'jpg' }) @Matches(/^[a-z0-9]{2,5}$/) ext: string;
  @ApiPropertyOptional({ description: 'Unit code, used to file EC8A photos' }) @IsOptional() @Matches(/^\d{2}-\d{2}-\d{2}-\d{3}$/) pu?: string;
}
class ViewDto {
  @ApiProperty({ enum: ['ec8a', 'incident', 'message', 'irev', 'callback', 'live'] }) @IsIn(['ec8a', 'incident', 'message', 'irev', 'callback', 'live']) kind: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() id?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) index?: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() electionId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() pu?: string;
}

/** File types served from local storage (by extension) */
const TYPES: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  mp4: 'video/mp4', webm: 'video/webm', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', mp3: 'audio/mpeg', csv: 'text/csv',
};

@ApiTags('Files')
@ApiBearerAuth()
@Controller()
export class MediaController {
  constructor(private readonly db: Db, private readonly storage: StorageService) {}

  /** A one-file upload link. The server picks the path under the caller's tenant; the app PUTs the file there. */
  @Post('media/upload-url') @HttpCode(200)
  @ApiOperation({ summary: 'Short-lived link to upload one photo, clip, voice note or document' })
  async upload(@CurrentUser() u: AuthUser, @Body() d: UploadDto) {
    const k = KINDS[d.kind];
    if (k.roles && !k.roles.includes(u.role)) throw new ForbiddenException('Your role cannot upload this');
    if (!k.ext.includes(d.ext)) throw new BadRequestException(`Allowed file types: ${k.ext.join(', ')}`);
    const path = `${u.tid}/${d.kind}/${d.pu ?? u.mid}/${randomUUID()}.${d.ext}`;
    return { path, ...(await this.storage.uploadUrl(k.bucket, path)) };
  }

  /** A view link for a file attached to a record the caller can see (the database decides). */
  @Post('media/view-url') @HttpCode(200)
  async view(@CurrentUser() u: AuthUser, @Body() b: ViewDto) {
    const found: { bucket: Bucket; path: string | null; link?: string } = await this.db.asUser(u, async (q) => {
      const one = async (sql: string, params: unknown[]) => (await q(sql, params))[0];
      switch (b.kind) {
        case 'ec8a': return { bucket: 'ec8a' as Bucket, path: (await one(`select sheet_photo_path p from public.result_submissions where id = $1`, [b.id]))?.p };
        case 'incident': return { bucket: 'incident-media' as Bucket, path: (await one(`select media_paths[$2 + 1] p from public.incidents where id = $1`, [b.id, b.index ?? 0]))?.p };
        case 'message': return { bucket: 'chat-media' as Bucket, path: (await one(`select media_path p from public.messages where id = $1`, [b.id]))?.p };
        case 'callback': return { bucket: 'voice-notes' as Bucket, path: (await one(`select voice_note_path p from public.callback_requests where id = $1`, [b.id]))?.p };
        case 'live': return { bucket: 'live-clips' as Bucket, path: (await one(`select media_path p from public.live_view_requests where id = $1`, [b.id]))?.p };
        case 'irev': {
          if (!ROOM.includes(u.role)) throw new ForbiddenException();
          const ok = await one(`select 1 from public.tenant_elections where tenant_id = $1 and election_id = $2`, [u.tid, b.electionId]);
          if (!ok) throw new NotFoundException();
          const a = await one(`select storage_path p, sheet_url l from public.irev_availability where election_id = $1 and pu_code = $2`, [b.electionId, b.pu]);
          // Only INEC's link saved: show it through this API (INEC's servers don't let a browser load it from our site)
          if (!a?.p && a?.l && /^\d{2}-\d{2}-\d{2}-\d{3}$/.test(b.pu ?? '')) return { bucket: 'irev' as Bucket, path: null, link: `${b.electionId}/${b.pu}` };
          return { bucket: 'irev' as Bucket, path: a?.p };
        }
      }
      return { bucket: 'ec8a' as Bucket, path: null };
    });
    const { bucket, path } = found;
    if ('link' in found && found.link) return { url: this.storage.apiLink('sheet-link', found.link), source: 'inec' };
    if (!path) throw new NotFoundException('File not found');
    return { url: await this.storage.viewUrl(bucket, path) };
  }

  /**
   * An IReV sheet we only saved INEC's link to, passed through from INEC for viewing (nothing is stored).
   * The link is signed and short-lived (from POST /media/view-url); tries INEC's other copies if one is down.
   */
  @Public() @Get('sheet-link/:election/:pu') @ApiExcludeEndpoint()
  async sheetLink(@Param('election') election: string, @Param('pu') pu: string, @Query() qs: any, @Res() res: Response) {
    if (!/^[0-9a-f-]{36}$/.test(election) || !/^\d{2}-\d{2}-\d{2}-\d{3}$/.test(pu)) throw new NotFoundException();
    this.storage.verifyApiLink('sheet-link', `${election}/${pu}`, qs.exp, qs.sig);
    const [a] = await this.db.system(`select sheet_url, document_url, backup_url from public.irev_availability where election_id = $1 and pu_code = $2`, [election, pu]);
    const urls = [...new Set([a?.sheet_url, a?.document_url, a?.backup_url].filter((x): x is string => typeof x === 'string' && /^https:\/\//.test(x)))];
    if (!urls.length) throw new NotFoundException('No link saved for this sheet');
    let last = 'INEC did not answer';
    for (const url of urls) {
      try {
        const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'Rumfa sheet viewer' } });
        if (!r.ok) { last = `INEC answered ${r.status}`; continue; }
        const body = Buffer.from(await r.arrayBuffer());
        res.type(r.headers.get('content-type') || (url.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'));
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.send(body);
        return;
      } catch (e) { last = (e as Error).message; }
    }
    res.status(502).type('text/plain').send(`Could not get the sheet from INEC: ${last}`);
  }

  // ---- Local storage driver (development and tests): signed links served by the API itself ----
  @Public() @Get('files/:bucket/*path') @ApiExcludeEndpoint()
  async localGet(@Param('bucket') bucket: string, @Param('path') path: string | string[], @Query() qs: any, @Res() res: Response) {
    const p = Array.isArray(path) ? path.join('/') : path;
    this.storage.verifyLocal('get', bucket, p, qs.exp, qs.sig);
    const body = await this.storage.readLocal(bucket, p);
    // Shown in the browser (not downloaded), and loadable by the dashboard on another origin: the link is signed and short-lived
    res.type(TYPES[p.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(body);
  }

  @Public() @Put('files/:bucket/*path') @HttpCode(200) @ApiExcludeEndpoint()
  async localPut(@Param('bucket') bucket: string, @Param('path') path: string | string[], @Query() qs: any, @Req() req: Request) {
    const p = Array.isArray(path) ? path.join('/') : path;
    this.storage.verifyLocal('put', bucket, p, qs.exp, qs.sig);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    await this.storage.writeLocal(bucket, p, Buffer.concat(chunks));
    return { ok: true };
  }
}
