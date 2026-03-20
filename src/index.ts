#!/usr/bin/env bun

import "dotenv/config";
import { Command } from "commander";

const program = new Command();

const stub = () => {
  console.log("not implemented yet");
};

program
  .name("notioncode")
  .description("NotionCode CLI")
  .command("run")
  .description("Process all Not started tickets")
  .action(stub);

program
  .command("start")
  .argument("<page_id>")
  .description("Process a single ticket")
  .action(() => stub());

program.command("setup").description("Validate configuration").action(stub);
program.command("serve").description("Start the local server").action(stub);

program.parse();
