import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCorrelationId1794920232623 implements MigrationInterface {
    name = 'AddCorrelationId1794920232623'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "executions" ADD "correlationId" character varying(128)`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD "correlationId" character varying(128)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "correlationId"`);
        await queryRunner.query(`ALTER TABLE "executions" DROP COLUMN "correlationId"`);
    }

}
