import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EngineService } from './engine.service';
import { ReceiptsService, ReceiptDto } from './receipts.service';
import { ReleasesService } from './releases.service';

@Controller('certs')
export class CertsController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  list() {
    return this.dataSource.query(`SELECT * FROM certificates ORDER BY created_at DESC`);
  }

  @Post()
  async create(@Body() body: any) {
    if (!body.domain || body.version == null || !body.content) {
      throw new BadRequestException('domain, version and content are required');
    }
    const rows = await this.dataSource.query(
      `INSERT INTO certificates (domain, version, content, status, not_before, not_after)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        body.domain,
        body.version,
        body.content,
        body.status || 'valid',
        body.notBefore || null,
        body.notAfter || null,
      ],
    );
    return rows[0];
  }

  @Post(':id/revoke')
  async revoke(@Param('id') id: string) {
    const rows = await this.dataSource.query(
      `UPDATE certificates SET status = 'revoked' WHERE id = $1 RETURNING *`,
      [id],
    );
    if (rows.length === 0) throw new NotFoundException();
    return rows[0];
  }
}

@Controller('nodes')
export class NodesController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  list() {
    return this.dataSource.query(
      `SELECT n.*,
              c.version AS current_cert_full_version, c.domain AS current_cert_domain,
              nc.release_id AS controlling_release_id, nc.epoch AS control_epoch,
              r.name AS controlling_release_name, r.kind AS controlling_release_kind,
              r.status AS controlling_release_status,
              (SELECT count(*)::int FROM receipts rc WHERE rc.node_id = n.id AND rc.late) AS late_receipt_count
         FROM nodes n
         LEFT JOIN certificates c ON c.id = n.current_cert_id
         LEFT JOIN node_control nc ON nc.node_id = n.id
         LEFT JOIN releases r ON r.id = nc.release_id
        ORDER BY n.name`,
    );
  }

  @Post()
  async create(@Body() body: any) {
    if (!body.name || !Array.isArray(body.domains)) {
      throw new BadRequestException('name and domains[] are required');
    }
    const rows = await this.dataSource.query(
      `INSERT INTO nodes (name, domains, current_cert_id, current_cert_version)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [body.name, JSON.stringify(body.domains), body.currentCertId || null, body.currentCertVersion ?? null],
    );
    return rows[0];
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    const nodes = await this.dataSource.query(`SELECT * FROM nodes WHERE id = $1`, [id]);
    if (nodes.length === 0) throw new NotFoundException();
    const control = await this.dataSource.query(
      `SELECT nc.*, r.name AS release_name, r.kind AS release_kind, r.status AS release_status
         FROM node_control nc JOIN releases r ON r.id = nc.release_id WHERE nc.node_id = $1`,
      [id],
    );
    const switches = await this.dataSource.query(
      `SELECT cs.*, f.name AS from_release_name, t.name AS to_release_name
         FROM control_switches cs
         LEFT JOIN releases f ON f.id = cs.from_release_id
         LEFT JOIN releases t ON t.id = cs.to_release_id
        WHERE cs.node_id = $1 ORDER BY cs.created_at DESC`,
      [id],
    );
    const receipts = await this.dataSource.query(
      `SELECT rc.*, r.name AS release_name
         FROM receipts rc LEFT JOIN releases r ON r.id = rc.release_id
        WHERE rc.node_id = $1 ORDER BY rc.received_at DESC LIMIT 100`,
      [id],
    );
    return { ...nodes[0], control: control[0] || null, switches, receipts };
  }
}

@Controller('releases')
export class ReleasesController {
  constructor(private readonly releases: ReleasesService) {}

  @Get()
  list() {
    return this.releases.listReleases();
  }

  @Post()
  create(@Body() body: any) {
    return this.releases.createRelease(body);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.releases.releaseDetail(id);
  }

  @Post(':id/start')
  start(@Param('id') id: string, @Body() body: any) {
    return this.releases.start(id, body?.operator || 'system');
  }

  @Get(':id/takeover-preview')
  preview(@Param('id') id: string) {
    return this.releases.takeoverPreview(id);
  }

  @Post(':id/takeover')
  takeover(@Param('id') id: string, @Body() body: any) {
    return this.releases.confirmTakeover(id, body?.operator || 'system');
  }

  @Post(':id/promote')
  promote(@Param('id') id: string) {
    return this.releases.promote(id);
  }

  @Post(':id/pause')
  pause(@Param('id') id: string) {
    return this.releases.pause(id);
  }

  @Post(':id/resume')
  resume(@Param('id') id: string) {
    return this.releases.resume(id);
  }

  @Post(':id/retry')
  retry(@Param('id') id: string) {
    return this.releases.retry(id);
  }

  @Post(':id/rollback')
  rollback(@Param('id') id: string, @Body() body: any) {
    return this.releases.rollback(id, body?.operator || 'system');
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Body() body: any) {
    return this.releases.cancel(id, body?.reason);
  }
}

@Controller('receipts')
export class ReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  /** callback target for the node simulator */
  @Post()
  receive(@Body() dto: ReceiptDto) {
    return this.receipts.handleReceipt(dto);
  }

  @Get()
  list(@Query() query: any) {
    return this.receipts.listReceipts(query);
  }
}

@Controller('admin')
export class AdminController {
  constructor(private readonly engine: EngineService) {}

  /** manual trigger for restart recovery (also runs automatically at boot) */
  @Post('recover')
  recover() {
    return this.engine.recover();
  }
}
