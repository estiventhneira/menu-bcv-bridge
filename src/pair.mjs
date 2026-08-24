// `print-bridge pair <CODE> [--url <app>] [--label <name>]`
//
// Exchanges a staff-generated pairing code (Configuración > Impresoras) for
// scoped device credentials and writes config.json itself — no hand-editing,
// no service role key. Pairing again with a code from another restaurant
// (sucursal on the same PC) appends it to the existing device account.

import os from "node:os";
import { createClient } from "@supabase/supabase-js";
import { configPath, readConfigRaw, saveConfigRaw } from "./config.mjs";

const DEFAULT_APP_URL = "https://andescocina.com";

function usage() {
  console.error("Uso: print-bridge pair <CODIGO> [--url <url de la app>] [--label <nombre>]");
  console.error("El código se genera en Configuración > Impresoras > Vincular bridge.");
  process.exit(2);
}

export async function runPair(args) {
  let code = null;
  let url = DEFAULT_APP_URL;
  let label = `bridge@${os.hostname()}`;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) url = args[++i];
    else if (args[i] === "--label" && args[i + 1]) label = args[++i];
    else if (!args[i].startsWith("-") && !code) code = args[i];
    else usage();
  }
  if (!code) usage();

  // An already-paired device proves its identity so the server reuses its
  // auth user instead of minting a second one (multi-sucursal PC).
  const existing = readConfigRaw();
  const existingIsDevice = !!(existing && (existing.anon_key || existing.device_email));
  let existingAccessToken = null;
  if (existingIsDevice) {
    const sb = createClient(existing.supabase_url, existing.anon_key, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    const { data, error } = await sb.auth.signInWithPassword({
      email: existing.device_email,
      password: existing.device_password,
    });
    if (error) {
      console.warn(`Aviso: no se pudo validar la vinculación existente (${error.message}); se creará una nueva.`);
    } else {
      existingAccessToken = data.session.access_token;
    }
  }

  let res;
  try {
    res = await fetch(new URL("/api/public/bridge/pair", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        device_label: label,
        existing_access_token: existingAccessToken ?? undefined,
      }),
    });
  } catch (e) {
    console.error(`No se pudo contactar ${url}: ${e.message}`);
    process.exit(1);
  }
  if (res.status === 404) {
    console.error("Código inválido o vencido. Generá uno nuevo en Configuración > Impresoras (dura 15 minutos).");
    process.exit(1);
  }
  if (res.status === 429) {
    console.error("Demasiados intentos desde esta red. Esperá unos minutos y probá de nuevo.");
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`Error del servidor (${res.status}). Intentá de nuevo.`);
    process.exit(1);
  }
  const body = await res.json();

  let raw;
  if (existingAccessToken && existingIsDevice) {
    // Append the new restaurant to the existing device config.
    const restaurants = Array.isArray(existing.restaurants) ? existing.restaurants : [];
    if (!restaurants.some((r) => r?.id === body.restaurant_id)) {
      restaurants.push({ id: body.restaurant_id, bridge_token_id: body.bridge_token_id });
    }
    raw = { ...existing, restaurants };
  } else {
    if (existing && !existingIsDevice) {
      console.warn("Reemplazando config antigua (service role key). Si esta PC imprimía para otras sucursales, generá un código en cada una y repetí `pair`.");
    }
    raw = {
      supabase_url: body.supabase_url,
      anon_key: body.anon_key,
      device_email: body.device_email,
      device_password: body.device_password,
      restaurants: [{ id: body.restaurant_id, bridge_token_id: body.bridge_token_id }],
      label,
    };
  }

  const p = saveConfigRaw(raw);
  console.log(`Listo: bridge vinculado (${raw.restaurants.length} restaurante(s)). Config: ${p}`);
  console.log("Iniciá el bridge (o reiniciá el servicio) para empezar a imprimir.");
}
