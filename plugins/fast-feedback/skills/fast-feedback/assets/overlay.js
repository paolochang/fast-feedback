// fast-feedback overlay engine — one self-contained IIFE, no dependencies.
//
// Used by BOTH modes:
//   - file mode: inject.mjs wraps this in a script tag inside a copy of a
//     static HTML mockup, and sets window.__FFB_FILE to the filename.
//   - live mode: build-live.mjs ships this verbatim as a console snippet /
//     bookmarklet the user pastes into a RUNNING app's page. Because it runs
//     inside the page (same origin), document.elementFromPoint sees the real
//     rendered components — which is why an iframe wrapper does NOT work for
//     live apps (cross-origin blocks reaching into the frame's DOM).
//
// UX model (explicit submit/discard, so nothing is lost by accident):
//   - Toggle annotate mode (bar button or Ctrl+/). Drag a box over anything.
//   - A draggable form pops up AT the box. Write the fix, Submit → the box is
//     committed with a number and the list count goes up. Close/Esc a new box
//     with text → asks before discarding; empty → just removes the box.
//   - The list (Ctrl+[) shows annotations as read-only text. Hover an item →
//     an edit pencil (top-left) and delete (top-right) appear. Edit turns it
//     into an inline form; Close on a changed edit asks before discarding.
//   - Copy all feedback: bar button or Ctrl+'.
//
// Everything is prefixed __ffb so it never clashes with the host page, the
// engine injects its own <style>, and re-running it just re-shows the bar.

(function () {
  if (window.__ffb_loaded) { if (window.__ffb_show) window.__ffb_show(); return; }
  window.__ffb_loaded = true;

  var BAR_H = 40; // top strip height; the page is pushed down by this much.
  // Colors are CSS custom properties so the whole overlay can flip light/dark by
  // toggling one class (__ffb_light) on <html>. The annotation-box gold and the
  // dark-text-on-gold (#1a1300) are theme-invariant on purpose — the box is a
  // marker that must read the same on any page.
  var CSS = [
    // --__ffb_gold is the accent/highlight (recolorable). --__ffb_onaccent is the
    // readable text on it; --__ffb_hlfill / --__ffb_hlflash are its translucent
    // box fills. JS overrides these when a custom highlight color is picked.
    ':root{--__ffb_gold:#e8b23f;--__ffb_onaccent:#231a00;--__ffb_hlfill:rgba(232,178,63,.14);--__ffb_hlflash:rgba(232,178,63,.5);--__ffb_ink:#e8eaf0;--__ffb_mut:#8b93a6;--__ffb_surf:#12151c;--__ffb_head:#0f1218;--__ffb_line:#2b3140;--__ffb_field:#0e1116;--__ffb_card:#171b23;--__ffb_btn:#1b2029;--__ffb_btnh:#222834;--__ffb_warn:#e06b5a;--__ffb_listen:#241a04;--__ffb_chip:#39445a;--__ffb_chipink:#e2e7f0;--__ffb_shadow:rgba(0,0,0,.5);--__ffb_shadowbar:rgba(0,0,0,.34)}',
    ':root.__ffb_light{--__ffb_gold:#e5484d;--__ffb_onaccent:#ffffff;--__ffb_hlfill:rgba(229,72,77,.13);--__ffb_hlflash:rgba(229,72,77,.4);--__ffb_ink:#1c2126;--__ffb_mut:#6b7480;--__ffb_surf:#f5f6f8;--__ffb_head:#eceef2;--__ffb_line:#e2e5ea;--__ffb_field:#ffffff;--__ffb_card:#ffffff;--__ffb_btn:#ffffff;--__ffb_btnh:#f0f1f4;--__ffb_warn:#c0392b;--__ffb_listen:#fdeaea;--__ffb_chip:#e0e4ec;--__ffb_chipink:#3d4655;--__ffb_shadow:rgba(17,24,39,.16);--__ffb_shadowbar:rgba(17,24,39,.07)}',
    '.__ffb_bar,.__ffb_form,.__ffb_panel,.__ffb_box,.__ffb_layer,.__ffb_confirm,.__ffb_modal{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
    // top strip
    '.__ffb_bar{position:fixed;z-index:2147483645;top:0;left:0;right:0;height:' + BAR_H + 'px;display:flex;gap:8px;align-items:center;padding:0 12px;background:var(--__ffb_surf);border-bottom:1px solid var(--__ffb_line);box-shadow:0 1px 0 var(--__ffb_line),0 2px 14px var(--__ffb_shadowbar);color:var(--__ffb_ink)}',
    '.__ffb_bar .__ffb_tag{display:inline-flex;align-items:center;gap:5px;font-size:15px;font-weight:800;color:var(--__ffb_gold);margin-right:3px;letter-spacing:.1px}',
    '.__ffb_logo{width:25px;height:17px;flex:none;display:block}',
    '.__ffb_bar .__ffb_k{color:var(--__ffb_mut);font-weight:500;font-size:12.5px}',
    '.__ffb_bar button{background:var(--__ffb_btn);color:var(--__ffb_ink);border:1px solid var(--__ffb_line);border-radius:7px;padding:5px 10px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}',
    '.__ffb_bar button.on{background:var(--__ffb_gold);color:var(--__ffb_onaccent);border-color:var(--__ffb_gold)}',
    '.__ffb_bar #__ffb_listbtn{display:inline-flex;align-items:center}',
    '.__ffb_bar .__ffb_cnt{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-width:18px;height:18px;padding:0 6px;background:var(--__ffb_gold);color:var(--__ffb_onaccent);border-radius:999px;font-size:11px;font-weight:800;line-height:1;margin-left:9px;font-variant-numeric:tabular-nums}',
    '.__ffb_bar .__ffb_spacer{flex:1}',
    // draw layer + boxes
    '.__ffb_layer{position:fixed;inset:0;z-index:2147483000;cursor:crosshair;display:none}',
    '.__ffb_layer.active{display:block}',
    '.__ffb_boxwrap{position:absolute;top:0;left:0;width:0;height:0;z-index:2147483200}',
    '.__ffb_box{position:absolute;border:2px solid var(--__ffb_gold);background:var(--__ffb_hlfill);pointer-events:auto;cursor:pointer}',
    '.__ffb_box.pending{border-style:dashed}',
    '.__ffb_box.flash{animation:__ffb_flash .9s ease}',
    '@keyframes __ffb_flash{0%,100%{background:var(--__ffb_hlfill)}40%{background:var(--__ffb_hlflash)}}',
    '.__ffb_box .__ffb_num{position:absolute;top:-1px;left:-1px;background:var(--__ffb_gold);color:var(--__ffb_onaccent);font-size:11px;font-weight:800;padding:1px 6px;border-radius:0 0 6px 0}',
    '.__ffb_box .__ffb_bdel{position:absolute;top:-11px;right:-11px;width:22px;height:22px;border-radius:50%;background:#c0392b;color:#fff;border:2px solid #fff;font-size:11px;line-height:1;cursor:pointer;display:none;align-items:center;justify-content:center;padding:0}',
    '.__ffb_box:hover .__ffb_bdel{display:flex}',
    '.__ffb_temp{position:absolute;border:2px dashed var(--__ffb_gold);background:var(--__ffb_hlfill);z-index:2147483200;pointer-events:none}',
    // shared floating card (form + panel)
    '.__ffb_form,.__ffb_panel{position:fixed;z-index:2147483646;background:var(--__ffb_surf);border:1px solid var(--__ffb_line);border-radius:10px;box-shadow:0 10px 34px var(--__ffb_shadow);color:var(--__ffb_ink);display:none;flex-direction:column;overflow:hidden}',
    '.__ffb_form.open,.__ffb_panel.open{display:flex}',
    '.__ffb_hd{display:flex;align-items:center;gap:6px;padding:8px 10px;background:var(--__ffb_head);border-bottom:1px solid var(--__ffb_line);cursor:move;user-select:none}',
    '.__ffb_hd .__ffb_ttl{font-size:12px;font-weight:700;color:var(--__ffb_gold);flex:1}',
    '.__ffb_hd .__ffb_x{cursor:pointer;background:none;border:none;color:var(--__ffb_mut);font-size:14px;line-height:1;padding:2px 4px}',
    '.__ffb_hd .__ffb_grip{color:var(--__ffb_mut);font-size:12px}',
    // form
    '.__ffb_form{width:300px}',
    '.__ffb_form .__ffb_sel{padding:6px 10px 0;color:var(--__ffb_mut);font-size:11px;word-break:break-all}',
    '.__ffb_form textarea{box-sizing:border-box;width:calc(100% - 20px);margin:8px 10px 0;background:var(--__ffb_field);color:var(--__ffb_ink);border:1px solid var(--__ffb_line);border-radius:6px;padding:7px 8px;font-size:13px;font-family:inherit;resize:vertical;min-height:60px}',
    '.__ffb_form textarea:focus,.__ffb_item textarea:focus{outline:none;border-color:var(--__ffb_gold)}',
    '.__ffb_form .__ffb_act{display:flex;gap:6px;justify-content:flex-end;padding:8px 10px 10px}',
    '.__ffb_btn{border-radius:7px;padding:5px 12px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;border:1px solid var(--__ffb_line);background:var(--__ffb_btn);color:var(--__ffb_ink)}',
    '.__ffb_btn.primary{background:var(--__ffb_gold);color:var(--__ffb_onaccent);border-color:var(--__ffb_gold)}',
    '.__ffb_hint{color:var(--__ffb_mut);font-size:11px;align-self:center;margin-right:auto}',
    // panel (list)
    '.__ffb_panel{width:330px;max-height:70vh}',
    '.__ffb_tabs{display:flex;gap:4px;padding:8px 10px 0;border-bottom:1px solid var(--__ffb_line)}',
    '.__ffb_tab{border:0;border-bottom:2px solid transparent;background:none;color:var(--__ffb_mut);padding:0 2px 7px;font:700 12px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;cursor:pointer}',
    '.__ffb_tab.sel{color:var(--__ffb_gold);border-color:var(--__ffb_gold)}',
    '.__ffb_panel .__ffb_list{overflow:auto;padding:10px;display:flex;flex-direction:column;gap:8px}',
    '.__ffb_empty{color:var(--__ffb_mut);font-size:12.5px;text-align:center;padding:14px 8px}',
    // Loading indicator — visually distinct from the empty state (a spinner), so a
    // tab switch to History reads as "loading", not a blank/empty panel.
    '.__ffb_loading{display:flex;flex-direction:column;align-items:center;gap:10px;color:var(--__ffb_mut);font-size:12.5px;padding:28px 8px}',
    '.__ffb_spin{width:22px;height:22px;border:2.5px solid var(--__ffb_line);border-top-color:var(--__ffb_gold);border-radius:50%;animation:__ffb_spin .7s linear infinite}',
    '@keyframes __ffb_spin{to{transform:rotate(360deg)}}',
    '.__ffb_item{position:relative;border:1px solid var(--__ffb_line);border-radius:8px;padding:8px 8px 8px 10px;background:var(--__ffb_card)}',
    '.__ffb_item .__ffb_n{color:var(--__ffb_gold);font-weight:800;font-size:12px;margin-right:6px}',
    '.__ffb_item .__ffb_isel{color:var(--__ffb_mut);font-size:11px;word-break:break-all}',
    '.__ffb_item .__ffb_hdrow{padding-right:48px}',
    '.__ffb_item .__ffb_cmt{color:var(--__ffb_ink);font-size:13px;margin-top:4px;white-space:pre-wrap;word-break:break-word}',
    '.__ffb_item .__ffb_tools{position:absolute;top:6px;right:6px;display:none;gap:4px}',
    '.__ffb_item:hover .__ffb_tools{display:flex}',
    '.__ffb_ic{width:22px;height:22px;border-radius:6px;border:1px solid var(--__ffb_line);background:var(--__ffb_surf);color:var(--__ffb_ink);font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}',
    '.__ffb_ic:hover{border-color:var(--__ffb_gold)}',
    '.__ffb_item textarea{box-sizing:border-box;width:100%;background:var(--__ffb_field);color:var(--__ffb_ink);border:1px solid var(--__ffb_line);border-radius:6px;padding:6px 8px;font-size:13px;font-family:inherit;resize:vertical;min-height:52px}',
    '.__ffb_item .__ffb_iact{display:flex;gap:6px;justify-content:flex-end;margin-top:6px}',
    '.__ffb_hist{display:flex;gap:9px}',
    '.__ffb_histthumb{width:72px;height:52px;flex:none;object-fit:cover;border:1px solid var(--__ffb_line);border-radius:5px;background:var(--__ffb_field)}',
    '.__ffb_histbody{min-width:0;flex:1}',
    '.__ffb_histmeta{color:var(--__ffb_mut);font-size:11px}',
    '.__ffb_histpreview{color:var(--__ffb_ink);font-size:12.5px;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.__ffb_hist{cursor:pointer}',
    '.__ffb_histdetail{display:flex;flex-direction:column;gap:8px}',
    '.__ffb_histshot{position:relative;width:100%;line-height:0}',
    '.__ffb_histshot img{display:block;width:100%;height:auto;cursor:zoom-in}',
    '.__ffb_histshot .__ffb_box{pointer-events:none}',
    '.__ffb_histlightbox{position:fixed;z-index:2147483647;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}',
    '.__ffb_histlightboxshot{position:relative;line-height:0}',
    '.__ffb_histlightboxshot img{display:block;max-width:92vw;max-height:92vh;width:auto;height:auto;object-fit:contain}',
    '.__ffb_histlightboxshot .__ffb_box{pointer-events:none}',
    '.__ffb_histlightboxx{position:absolute;top:12px;right:12px;z-index:1;border:0;background:var(--__ffb_surf);color:var(--__ffb_ink);border-radius:50%;width:30px;height:30px;cursor:pointer;font-size:18px;line-height:1}',
    // confirm
    '.__ffb_confirm{position:fixed;z-index:2147483647;inset:0;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center}',
    '.__ffb_confirm.open{display:flex}',
    '.__ffb_confirm .__ffb_dlg{background:var(--__ffb_surf);border:1px solid var(--__ffb_line);border-radius:10px;padding:16px;width:280px;color:var(--__ffb_ink);box-shadow:0 14px 44px var(--__ffb_shadow)}',
    '.__ffb_confirm .__ffb_dlg p{margin:0 0 14px;font-size:13.5px}',
    '.__ffb_confirm .__ffb_dlg .__ffb_act{display:flex;gap:8px;justify-content:flex-end}',
    // settings (centered, non-draggable)
    '.__ffb_bar #__ffb_setbtn{padding:4px 9px;font-size:17px;line-height:1}',
    '.__ffb_modal{position:fixed;z-index:2147483647;inset:0;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center}',
    '.__ffb_modal.open{display:flex}',
    '.__ffb_setdlg{background:var(--__ffb_surf);border:1px solid var(--__ffb_line);border-radius:10px;width:380px;max-width:calc(100vw - 24px);color:var(--__ffb_ink);box-shadow:0 12px 40px rgba(0,0,0,.6);overflow:hidden}',
    '.__ffb_setdlg .__ffb_hd2{display:flex;align-items:center;gap:6px;padding:10px 12px;background:var(--__ffb_head);border-bottom:1px solid var(--__ffb_line)}',
    '.__ffb_setdlg .__ffb_hd2 .__ffb_ttl{font-size:12.5px;font-weight:700;color:var(--__ffb_gold);flex:1}',
    '.__ffb_setdlg .__ffb_hd2 .__ffb_x{cursor:pointer;background:none;border:none;color:var(--__ffb_mut);font-size:14px;line-height:1;padding:2px 4px}',
    '.__ffb_srows{padding:10px 12px;display:flex;flex-direction:column;gap:7px;max-height:62vh;overflow:auto}',
    '.__ffb_srow{display:flex;align-items:center;gap:10px}',
    '.__ffb_srow .__ffb_slabel{flex:1;font-size:13px;color:var(--__ffb_ink)}',
    '.__ffb_seg{display:flex;gap:4px}',
    '.__ffb_segbtn{border-radius:6px;padding:4px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;border:1px solid var(--__ffb_line);background:var(--__ffb_field);color:var(--__ffb_ink)}',
    '.__ffb_segbtn.sel{background:var(--__ffb_gold);color:var(--__ffb_onaccent);border-color:var(--__ffb_gold)}',
    '.__ffb_srow_sep{border-top:1px solid var(--__ffb_line);margin:3px 0 1px}',
    '.__ffb_keybtn{min-width:132px;text-align:center;border-radius:7px;padding:5px 10px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;border:1px solid var(--__ffb_line);background:var(--__ffb_field);color:var(--__ffb_ink);font-variant-numeric:tabular-nums}',
    '.__ffb_keybtn:hover{border-color:var(--__ffb_gold)}',
    '.__ffb_keybtn.listening{border-color:var(--__ffb_gold);color:var(--__ffb_gold);background:var(--__ffb_listen)}',
    '.__ffb_snote{padding:2px 12px 0;color:var(--__ffb_mut);font-size:11.5px;min-height:16px}',
    '.__ffb_snote.warn{color:var(--__ffb_warn)}',
    '.__ffb_setact{display:flex;gap:8px;justify-content:flex-end;padding:10px 12px 12px}',
    // hover polish for bar + secondary buttons
    '.__ffb_bar button:hover{background:var(--__ffb_btnh);border-color:var(--__ffb_line)}',
    '.__ffb_bar button.on:hover{background:var(--__ffb_gold)}',
    '.__ffb_btn:hover,.__ffb_segbtn:hover{background:var(--__ffb_btnh)}',
    '.__ffb_btn.primary:hover,.__ffb_segbtn.sel:hover{background:var(--__ffb_gold)}',
    // highlight color row (hex readout + swatch button that opens our picker)
    '.__ffb_hlsec{display:flex;flex-direction:column;gap:9px}',
    '.__ffb_swatchwrap{display:flex;align-items:center;gap:9px}',
    '.__ffb_hex{font-size:11.5px;color:var(--__ffb_mut);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;min-width:60px;text-align:right}',
    '.__ffb_swbtn{width:30px;height:24px;padding:0;border:1px solid var(--__ffb_line);border-radius:6px;cursor:pointer;box-shadow:inset 0 0 0 2px var(--__ffb_surf)}',
    '.__ffb_reset{background:none;border:none;color:var(--__ffb_mut);font-size:11.5px;font-weight:600;cursor:pointer;font-family:inherit;padding:2px 4px}',
    '.__ffb_reset:hover{color:var(--__ffb_gold);text-decoration:underline}',
    // custom color picker popover (replaces the un-styleable native one)
    '.__ffb_cpick{position:fixed;z-index:2147483647;display:none;flex-direction:column;gap:10px;width:216px;padding:12px;box-sizing:border-box;background:var(--__ffb_surf);border:1px solid var(--__ffb_line);border-radius:10px;box-shadow:0 12px 40px var(--__ffb_shadow);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
    '.__ffb_cpick.open{display:flex}',
    '.__ffb_sv{position:relative;width:100%;height:132px;border-radius:7px;overflow:hidden;cursor:crosshair;border:1px solid var(--__ffb_line)}',
    '.__ffb_svwhite{position:absolute;inset:0;background:linear-gradient(to right,#fff,rgba(255,255,255,0))}',
    '.__ffb_svblack{position:absolute;inset:0;background:linear-gradient(to top,#000,rgba(0,0,0,0))}',
    '.__ffb_svthumb{position:absolute;width:12px;height:12px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.45);transform:translate(-50%,-50%);pointer-events:none}',
    '.__ffb_hue{position:relative;height:12px;border-radius:7px;cursor:pointer;background:linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)}',
    '.__ffb_huethumb{position:absolute;top:50%;width:14px;height:14px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.45);transform:translate(-50%,-50%);pointer-events:none}',
    '.__ffb_cprow{display:flex;align-items:center;gap:8px}',
    '.__ffb_cphex{width:80px;box-sizing:border-box;background:var(--__ffb_field);color:var(--__ffb_ink);border:1px solid var(--__ffb_line);border-radius:6px;padding:5px 7px;font-size:11.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase}',
    '.__ffb_cprgb{display:flex;gap:8px;flex:1;justify-content:flex-end}',
    '.__ffb_cprgb span{font-size:10.5px;color:var(--__ffb_mut);font-variant-numeric:tabular-nums}',
    '.__ffb_cppal{display:flex;gap:8px;justify-content:space-between}',
    '.__ffb_sw{width:24px;height:24px;border-radius:7px;border:1px solid rgba(127,127,127,.28);cursor:pointer;padding:0;transition:transform .08s ease}',
    '.__ffb_sw:hover{transform:translateY(-1px)}',
    '.__ffb_sw.sel{box-shadow:0 0 0 2px var(--__ffb_surf),0 0 0 4px var(--__ffb_gold)}',
    // screenshot save-to-folder (toggle switch + path field)
    '.__ffb_toggle2{position:relative;width:38px;height:22px;flex:none;padding:0;border-radius:999px;border:1px solid var(--__ffb_line);background:var(--__ffb_field);cursor:pointer;transition:background .15s,border-color .15s}',
    '.__ffb_toggle2.on{background:var(--__ffb_gold);border-color:var(--__ffb_gold)}',
    '.__ffb_toggle2 .__ffb_knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.35);transition:left .15s}',
    '.__ffb_toggle2.on .__ffb_knob{left:18px}',
    '.__ffb_pathin{box-sizing:border-box;width:100%;background:var(--__ffb_field);color:var(--__ffb_ink);border:1px solid var(--__ffb_line);border-radius:6px;padding:6px 8px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
    '.__ffb_pathin:disabled{opacity:.5;cursor:not-allowed}',
    '.__ffb_shothint{color:var(--__ffb_mut);font-size:11px;line-height:1.45}',
    // custom tooltip (short text + keycap chips)
    '.__ffb_tip{position:fixed;z-index:2147483647;display:none;align-items:center;gap:8px;background:var(--__ffb_surf);border:1px solid var(--__ffb_line);border-radius:8px;padding:6px 8px 6px 10px;box-shadow:0 8px 24px var(--__ffb_shadow);color:var(--__ffb_ink);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:12px;white-space:nowrap;pointer-events:none}',
    '.__ffb_tip.open{display:flex}',
    '.__ffb_toast{position:fixed;z-index:2147483647;right:14px;bottom:14px;display:none;max-width:320px;padding:9px 12px;background:var(--__ffb_surf);border:1px solid var(--__ffb_line);border-radius:8px;box-shadow:0 8px 24px var(--__ffb_shadow);color:var(--__ffb_ink);font:600 12.5px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
    '.__ffb_toast.open{display:block}',
    '.__ffb_toast.error{color:var(--__ffb_warn);border-color:var(--__ffb_warn)}',
    '.__ffb_tiptext{color:var(--__ffb_ink);font-weight:500}',
    '.__ffb_keys{display:inline-flex;align-items:center;gap:4px}',
    '.__ffb_kbd{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-width:20px;height:20px;padding:0 7px;background:var(--__ffb_chip);color:var(--__ffb_chipink);border:1px solid rgba(127,127,127,.22);border-radius:6px;font-size:11px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}',
    '.__ffb_kbdsym{min-width:22px;padding:0 5px;font-size:13px;font-weight:600;font-family:"Segoe UI Symbol",system-ui,-apple-system,sans-serif}',
    // The ⇧/⌘/⌥ glyphs sit optically high in their em box; nudge the wrapper down
    // a hair so the mark lands in the visual centre of the chip.
    '.__ffb_glyph{display:flex;align-items:center;justify-content:center;line-height:1;transform:translateY(1px)}'
  ].join("");

  var style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  // Push the page down so the top strip never overlaps the app's own header.
  var prevBodyMt = document.body.style.marginTop;
  document.body.style.marginTop = BAR_H + "px";

  var FILE = window.__FFB_FILE || document.title || (location.pathname + location.search) || "frontend";
  var anns = [];            // committed: {id, n, sel, region, comment, sent, revision, boxEl}
  var counter = 0;
  var active = false, drawing = false, startPage = null, tempEl = null;
  var draft = null;         // in-progress NEW annotation: {sel, region, boxEl}

  var root = document.documentElement;

  // ---- bar (top strip) --------------------------------------------------
  var bar = document.createElement("div");
  bar.className = "__ffb_bar";
  // Logo: a pen streaking left with speed lines trailing to the right — the
  // "fast" in fast-feedback. Drawn as ONE body (soft rounded ends via round line
  // joins) that tapers to a sharp nib, so barrel and tip flow together with no
  // seam. currentColor tracks the theme accent (gold in dark, red in light).
  var LOGO =
    '<svg class="__ffb_logo" viewBox="0 0 26 18" fill="none" aria-hidden="true">' +
    '<g stroke="currentColor" stroke-width="1.7" stroke-linecap="round">' +
    '<path d="M14 4.6 H22" opacity="0.5"/>' +
    '<path d="M13 8.5 H25" opacity="0.85"/>' +
    '<path d="M14.5 12.2 H22.5" opacity="0.5"/>' +
    '</g>' +
    '<path d="M3 14.4 L7.1 12.84 L14.47 5.47 L11.93 2.93 L4.56 10.3 Z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"/>' +
    '</svg>';
  bar.innerHTML =
    '<span class="__ffb_tag">' + LOGO + 'Feedback</span>' +
    '<span class="__ffb_k" id="__ffb_file"></span>' +
    '<span class="__ffb_spacer"></span>' +
    '<button id="__ffb_toggle">Write</button>' +
    '<button id="__ffb_listbtn">List<span class="__ffb_cnt" id="__ffb_cnt">0</span></button>' +
    '<button id="__ffb_copybtn">Copy All</button>' +
    '<button id="__ffb_shotbtn">Screenshot</button>' +
    '<button id="__ffb_setbtn">⚙</button>';
  root.appendChild(bar);
  bar.querySelector("#__ffb_file").textContent = FILE;
  var toast = document.createElement("div");
  toast.className = "__ffb_toast";
  root.appendChild(toast);
  var toastTimer = null;
  function showToast(message, error) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.className = "__ffb_toast open" + (error ? " error" : "");
    toastTimer = setTimeout(function () { toast.className = "__ffb_toast"; }, 2600);
  }

  var layer = document.createElement("div");
  layer.className = "__ffb_layer";
  root.appendChild(layer);

  var boxwrap = document.createElement("div");
  boxwrap.className = "__ffb_boxwrap";
  root.appendChild(boxwrap);

  // ---- popup form (for NEW annotations) ---------------------------------
  var form = document.createElement("div");
  form.className = "__ffb_form";
  form.innerHTML =
    '<div class="__ffb_hd"><span class="__ffb_grip">⠿</span><span class="__ffb_ttl">New annotation</span><button class="__ffb_x" title="Close">✕</button></div>' +
    '<div class="__ffb_sel" id="__ffb_fsel"></div>' +
    '<textarea id="__ffb_fta" placeholder="What should change here..."></textarea>' +
    '<div class="__ffb_act"><span class="__ffb_hint">Ctrl+Enter submit · Esc cancel</span><button class="__ffb_btn" id="__ffb_fcancel">Cancel</button><button class="__ffb_btn primary" id="__ffb_fsubmit">Submit</button></div>';
  root.appendChild(form);
  var fSel = form.querySelector("#__ffb_fsel");
  var fTa = form.querySelector("#__ffb_fta");

  // ---- list panel -------------------------------------------------------
  var panel = document.createElement("div");
  panel.className = "__ffb_panel";
  panel.innerHTML =
    '<div class="__ffb_hd"><span class="__ffb_grip">⠿</span><span class="__ffb_ttl">Feedback (<span id="__ffb_ptitlecnt">0</span>)</span>' +
    '<button class="__ffb_btn" id="__ffb_pcopy" style="padding:3px 9px">Copy</button>' +
    '<button class="__ffb_btn" id="__ffb_pclear" style="padding:3px 9px">Clear</button>' +
    '<button class="__ffb_x" title="Close">✕</button></div>' +
    '<div class="__ffb_tabs"><button class="__ffb_tab sel" data-tab="live">Live</button><button class="__ffb_tab" data-tab="history">History</button></div>' +
    '<div class="__ffb_list" id="__ffb_items"></div>' +
    '<div id="__ffb_foot" style="padding:10px 12px;border-top:1px solid var(--__ffb_line);display:flex">' +
    '<button class="__ffb_btn primary" id="__ffb_psend" title="Send new feedback to AI" style="flex:1;padding:8px 12px">Send to AI</button></div>';
  root.appendChild(panel);
  var itemsEl = panel.querySelector("#__ffb_items");
  var activeListTab = "live", historyRows = null, historyLoading = false, historyError = false;
  var historyVisibleCount = 10, historyObjectUrls = [], historyObserver = null, historyDetailId = null, historyLightbox = null;

  // ---- confirm dialog ---------------------------------------------------
  var confirmEl = document.createElement("div");
  confirmEl.className = "__ffb_confirm";
  confirmEl.innerHTML =
    '<div class="__ffb_dlg"><p id="__ffb_cmsg"></p>' +
    '<div class="__ffb_act"><button class="__ffb_btn" id="__ffb_cno">Cancel</button><button class="__ffb_btn primary" id="__ffb_cyes">Discard</button></div></div>';
  root.appendChild(confirmEl);
  var confirmCb = null;
  confirmEl.querySelector("#__ffb_cno").onclick = function () { confirmEl.classList.remove("open"); confirmCb = null; };
  confirmEl.querySelector("#__ffb_cyes").onclick = function () { confirmEl.classList.remove("open"); var cb = confirmCb; confirmCb = null; if (cb) cb(); };
  // msg + optional button labels (default Cancel / Discard). Destructive actions
  // pass their own verb (e.g. "Clear") so the confirm reads unambiguously.
  function confirmDiscard(msg, cb, noLabel, yesLabel) {
    confirmEl.querySelector("#__ffb_cmsg").textContent = msg;
    confirmEl.querySelector("#__ffb_cno").textContent = noLabel || "Cancel";
    confirmEl.querySelector("#__ffb_cyes").textContent = yesLabel || "Discard";
    confirmCb = cb; confirmEl.classList.add("open");
  }

  // ---- helpers ----------------------------------------------------------
  function makeDraggable(el, handle) {
    handle.addEventListener("pointerdown", function (e) {
      if (e.target.closest("button")) return; // don't drag when hitting a header button
      var r = el.getBoundingClientRect();
      var dx = e.clientX - r.left, dy = e.clientY - r.top;
      el.style.right = "auto";
      function mv(ev) {
        var x = Math.max(0, Math.min(window.innerWidth - 40, ev.clientX - dx));
        var y = Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - dy));
        el.style.left = x + "px"; el.style.top = y + "px";
      }
      function up() { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); }
      window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
    });
  }
  makeDraggable(form, form.querySelector(".__ffb_hd"));
  makeDraggable(panel, panel.querySelector(".__ffb_hd"));

  function selectorFor(el) {
    if (!el || el === document.body || el === document.documentElement) return "page";
    var s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    else if (typeof el.className === "string" && el.className.trim()) {
      var c = el.className.trim().split(/\s+/).filter(function (x) { return x.indexOf("__ffb") !== 0; }).slice(0, 2);
      if (c.length) s += "." + c.join(".");
    }
    var txt = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30);
    if (txt) s += ' "' + txt + '"';
    return s;
  }
  function elAt(cx, cy) {
    layer.style.pointerEvents = "none";
    var el = document.elementFromPoint(cx, cy);
    layer.style.pointerEvents = "";
    return el;
  }
  function clampToView(x, y, w, h) {
    return { x: Math.max(6, Math.min(window.innerWidth - w - 6, x)), y: Math.max(BAR_H + 6, Math.min(window.innerHeight - h - 6, y)) };
  }

  // "Write" arms the highlight cursor. It's NOT a sticky toggle: after one box
  // is drawn it disarms itself (see mouseup) so you don't leave a crosshair on
  // by accident. Clicking again before drawing / Ctrl+/ re-arms or cancels it.
  function setActive(v) {
    active = v;
    layer.classList.toggle("active", v);
    bar.querySelector("#__ffb_toggle").classList.toggle("on", v);
  }

  // ---- drawing → new annotation ----------------------------------------
  layer.addEventListener("mousedown", function (e) {
    if (!active) return;
    drawing = true;
    startPage = { x: e.pageX, y: e.pageY, cx: e.clientX, cy: e.clientY };
    tempEl = document.createElement("div");
    tempEl.className = "__ffb_temp";
    boxwrap.appendChild(tempEl);
  });
  window.addEventListener("mousemove", function (e) {
    if (!drawing || !tempEl) return;
    var x = Math.min(e.pageX, startPage.x), y = Math.min(e.pageY, startPage.y);
    tempEl.style.left = x + "px"; tempEl.style.top = y + "px";
    tempEl.style.width = Math.abs(e.pageX - startPage.x) + "px";
    tempEl.style.height = Math.abs(e.pageY - startPage.y) + "px";
  });
  window.addEventListener("mouseup", function (e) {
    if (!drawing || !tempEl) return;
    drawing = false;
    var left = parseFloat(tempEl.style.left) || 0, top = parseFloat(tempEl.style.top) || 0;
    var w = parseFloat(tempEl.style.width) || 0, h = parseFloat(tempEl.style.height) || 0;
    tempEl.remove(); tempEl = null;
    if (w < 8 || h < 8) return;
    var cx = (startPage.cx + e.clientX) / 2, cy = (startPage.cy + e.clientY) / 2;
    var sel = selectorFor(elAt(cx, cy));
    var docW = document.documentElement.clientWidth || 1, docH = document.documentElement.scrollHeight || 1;
    var pct = function (v, base) { return Math.round((v / base) * 100); };
    var region = { x: pct(left, docW), y: pct(top, docH), w: pct(w, docW), h: pct(h, docH) };
    var box = document.createElement("div");
    box.className = "__ffb_box pending";
    box.style.left = left + "px"; box.style.top = top + "px"; box.style.width = w + "px"; box.style.height = h + "px";
    boxwrap.appendChild(box);
    draft = { sel: sel, region: region, boxEl: box };
    openForm(sel, "", e.clientX, e.clientY);
    setActive(false); // one-shot: disarm the highlight cursor after one box
  });

  function openForm(sel, comment, nearX, nearY) {
    fSel.textContent = sel;
    fTa.value = comment;
    form.classList.add("open");
    var fw = 300, fh = 170;
    var pos = clampToView((nearX || window.innerWidth / 2) + 12, (nearY || window.innerHeight / 2) + 12, fw, fh);
    form.style.right = "auto"; form.style.left = pos.x + "px"; form.style.top = pos.y + "px";
    setTimeout(function () { fTa.focus(); }, 0);
  }
  function closeFormDiscard() {
    // called when abandoning a NEW draft
    if (draft && draft.boxEl) draft.boxEl.remove();
    draft = null;
    form.classList.remove("open");
  }
  function submitForm() {
    if (!draft) { form.classList.remove("open"); return; }
    var n = ++counter;
    var ann = { id: crypto.randomUUID(), n: n, sel: draft.sel, region: draft.region, comment: fTa.value.trim(), sent: false, revision: 0, boxEl: draft.boxEl };
    decorateBox(ann);
    anns.push(ann);
    draft = null;
    form.classList.remove("open");
    renderList();
  }
  // Commit a box: number badge + a hover delete (top-right) that removes the
  // whole annotation. The delete stops propagation so it doesn't also open the
  // list via the box's own click.
  function decorateBox(a) {
    var box = a.boxEl;
    box.className = "__ffb_box";
    box.innerHTML = '<div class="__ffb_num">' + a.n + '</div><button class="__ffb_bdel" title="Delete this highlight">🗑</button>';
    box.onclick = function () { openList(); flashBox(a.n); };
    box.querySelector(".__ffb_bdel").onclick = function (e) { e.stopPropagation(); deleteAnn(a); };
  }
  function deleteAnn(a) {
    confirmDiscard("Delete annotation [" + a.n + "]? This can't be undone.", function () {
      if (a.boxEl) a.boxEl.remove();
      anns.splice(anns.indexOf(a), 1);
      if (editingN === a.n) editingN = null;
      renderList();
    }, "Cancel", "Discard");
  }
  form.querySelector("#__ffb_fsubmit").onclick = submitForm;
  form.querySelector("#__ffb_fcancel").onclick = tryCloseForm;
  form.querySelector(".__ffb_x").onclick = tryCloseForm;
  function tryCloseForm() {
    if (fTa.value.trim()) confirmDiscard("Discard this annotation?", closeFormDiscard);
    else closeFormDiscard();
  }
  fTa.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitForm(); }
    else if (e.key === "Escape") { e.preventDefault(); tryCloseForm(); }
  });

  // ---- list (read-only + inline edit) ----------------------------------
  var editingN = null;
  function openList() { panel.classList.add("open"); if (!panel.style.left) { panel.style.right = "auto"; panel.style.left = (window.innerWidth - 350) + "px"; panel.style.top = (BAR_H + 12) + "px"; } renderList(); }
  function toggleList() { if (panel.classList.contains("open")) closeList(); else openList(); }
  function flashBox(n) {
    var a = anns.filter(function (x) { return x.n === n; })[0];
    if (a && a.boxEl) { a.boxEl.classList.remove("flash"); void a.boxEl.offsetWidth; a.boxEl.classList.add("flash"); a.boxEl.scrollIntoView({ block: "center", behavior: "smooth" }); }
  }
  function updateCount() {
    bar.querySelector("#__ffb_cnt").textContent = anns.length;
    panel.querySelector("#__ffb_ptitlecnt").textContent = anns.length;
  }
  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

  function hasIndexedDb() {
    try { return !!window.indexedDB; } catch (e) { return false; }
  }

  var historyStore = (function () {
    var dbPromise;

    function openDb() {
      if (!dbPromise) {
        dbPromise = new Promise(function (resolve, reject) {
          var request;
          try {
            if (!hasIndexedDb()) throw new Error("IndexedDB is unavailable");
            request = window.indexedDB.open("ffb", 1);
          } catch (e) {
            reject(e);
            return;
          }
          request.onupgradeneeded = function () {
            var db = request.result;
            if (!db.objectStoreNames.contains("history")) db.createObjectStore("history", { keyPath: "id" });
          };
          request.onsuccess = function () { resolve(request.result); };
          request.onerror = function () { reject(request.error); };
        });
      }
      return dbPromise;
    }

    function requestStore(mode, action) {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var request = action(db.transaction("history", mode).objectStore("history"));
          request.onsuccess = function () { resolve(request.result); };
          request.onerror = function () { reject(request.error); };
        });
      });
    }

    function getRecord(id) {
      return requestStore("readonly", function (store) { return store.get(id); });
    }

    return {
      archive: function (meta, pngBlob) {
        if (typeof window.__FFB_ARCHIVE === "function") {
          var json = new TextEncoder().encode(JSON.stringify(meta));
          var framing = new TextEncoder().encode(String(json.length) + "\n");
          try {
            return Promise.resolve(window.__FFB_ARCHIVE(new Blob([framing, json, pngBlob], { type: "application/x-ffb-history" })));
          } catch (e) {
            return Promise.reject(e);
          }
        }
        return requestStore("readwrite", function (store) { return store.put({ id: meta.id, meta: meta, pngBlob: pngBlob }); });
      },
      list: function () {
        if (typeof window.__FFB_HISTORY_LIST === "function") {
          try { return Promise.resolve(window.__FFB_HISTORY_LIST()); } catch (e) { return Promise.reject(e); }
        }
        return requestStore("readonly", function (store) { return store.getAll(); }).then(function (records) {
          return records.map(function (record) {
            var meta = record.meta || {}, preview = "";
            (Array.isArray(meta.items) ? meta.items : []).some(function (item) {
              if (String(item.comment || "").trim()) { preview = item.comment; return true; }
              return false;
            });
            return { id: record.id, ts: meta.ts, url: meta.url, count: (meta.items || []).length, preview: preview };
          }).sort(function (a, b) { return (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0); });
        });
      },
      getMeta: function (id) {
        if (typeof window.__FFB_HISTORY_META === "function") {
          try { return Promise.resolve(window.__FFB_HISTORY_META(id)); } catch (e) { return Promise.reject(e); }
        }
        return getRecord(id).then(function (record) { return record && record.meta; });
      },
      getBlob: function (id) {
        if (typeof window.__FFB_HISTORY_BLOB === "function") {
          try { return Promise.resolve(window.__FFB_HISTORY_BLOB(id)); } catch (e) { return Promise.reject(e); }
        }
        return getRecord(id).then(function (record) { return record && record.pngBlob; });
      }
    };
  }());

  function renderList() {
    updateCount();
    if (activeListTab === "history") { renderHistory(); return; }
    clearHistoryThumbs();
    renderLiveList();
  }

  function renderLiveList() {
    itemsEl.innerHTML = "";
    if (!anns.length) { itemsEl.innerHTML = '<div class="__ffb_empty">No feedback yet.<br>Arm Write and drag a box over the page.</div>'; return; }
    anns.forEach(function (a) {
      var item = document.createElement("div");
      item.className = "__ffb_item"; item.setAttribute("data-n", a.n);
      if (editingN === a.n) {
        item.innerHTML =
          '<div><span class="__ffb_n">[' + a.n + ']</span><span class="__ffb_isel">' + esc(a.sel) + '</span></div>' +
          '<textarea>' + esc(a.comment) + '</textarea>' +
          '<div class="__ffb_iact"><button class="__ffb_btn __ffb_ec">Close</button><button class="__ffb_btn primary __ffb_es">Save</button></div>';
        var ta = item.querySelector("textarea");
        setTimeout(function () { ta.focus(); }, 0);
        var save = function () {
          var comment = ta.value.trim();
          if (comment !== a.comment) { a.comment = comment; a.sentToInbox = false; a.revision++; }
          editingN = null; renderList();
        };
        var closeEdit = function () {
          if (ta.value.trim() !== a.comment) confirmDiscard("Discard your changes?", function () { editingN = null; renderList(); });
          else { editingN = null; renderList(); }
        };
        item.querySelector(".__ffb_es").onclick = save;
        item.querySelector(".__ffb_ec").onclick = closeEdit;
        ta.addEventListener("keydown", function (e) {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
          else if (e.key === "Escape") { e.preventDefault(); closeEdit(); }
        });
      } else {
        item.innerHTML =
          '<div class="__ffb_tools"><button class="__ffb_ic __ffb_edit" title="Edit">✎</button><button class="__ffb_ic __ffb_del" title="Delete">🗑</button></div>' +
          '<div class="__ffb_hdrow"><span class="__ffb_n">[' + a.n + ']</span><span class="__ffb_isel">' + esc(a.sel) + '</span></div>' +
          '<div class="__ffb_cmt">' + (a.comment ? esc(a.comment) : '<span style="color:var(--__ffb_mut)">(no comment)</span>') + '</div>';
        item.querySelector(".__ffb_edit").onclick = function () { editingN = a.n; renderList(); flashBox(a.n); };
        item.querySelector(".__ffb_del").onclick = function () { deleteAnn(a); };
        item.addEventListener("mouseenter", function () { flashBox(a.n); });
      }
      itemsEl.appendChild(item);
    });
  }

  function clearHistoryThumbs() {
    closeHistoryLightbox();
    if (historyObserver) { historyObserver.disconnect(); historyObserver = null; }
    historyObjectUrls.forEach(function (url) { URL.revokeObjectURL(url); });
    historyObjectUrls = [];
  }

  function appendHistoryBox(container, entry) {
    var region = entry.region || {}, box = document.createElement("div");
    box.className = "__ffb_box";
    box.style.left = Number(region.x) + "%";
    box.style.top = Number(region.y) + "%";
    box.style.width = Number(region.w) + "%";
    box.style.height = Number(region.h) + "%";
    var badge = document.createElement("div");
    badge.className = "__ffb_num";
    badge.textContent = entry.n;
    box.appendChild(badge);
    container.appendChild(box);
  }

  function closeHistoryLightbox() {
    if (!historyLightbox) return;
    document.removeEventListener("keydown", historyLightbox.onKeydown);
    historyLightbox.el.remove();
    historyLightbox = null;
  }

  function openHistoryLightbox(url, meta) {
    closeHistoryLightbox();
    var lightbox = document.createElement("div");
    lightbox.className = "__ffb_histlightbox";
    var close = document.createElement("button");
    close.className = "__ffb_histlightboxx";
    close.textContent = "✕";
    close.title = "Close";
    var shot = document.createElement("div");
    shot.className = "__ffb_histlightboxshot";
    var image = document.createElement("img");
    image.src = url;
    image.alt = "Archived feedback screenshot";
    shot.appendChild(image);
    (Array.isArray(meta && meta.items) ? meta.items : []).forEach(function (entry) { appendHistoryBox(shot, entry); });
    lightbox.appendChild(close);
    lightbox.appendChild(shot);
    root.appendChild(lightbox);
    var onKeydown = function (event) { if (event.key === "Escape") closeHistoryLightbox(); };
    historyLightbox = { el: lightbox, onKeydown: onKeydown };
    close.onclick = closeHistoryLightbox;
    lightbox.onclick = function (event) { if (event.target === lightbox) closeHistoryLightbox(); };
    document.addEventListener("keydown", onKeydown);
  }

  function historyTime(ts) {
    var date = new Date(ts);
    return isNaN(date.getTime()) ? String(ts || "") : date.toLocaleString();
  }

  function loadHistoryThumb(img, id) {
    if (img.getAttribute("data-loading")) return;
    img.setAttribute("data-loading", "1");
    historyStore.getBlob(id).then(function (blob) {
      var url = URL.createObjectURL(blob);
      if (!img.isConnected || activeListTab !== "history") { URL.revokeObjectURL(url); return; }
      historyObjectUrls.push(url);
      img.src = url;
    }).catch(function () {
      if (img.isConnected) img.alt = "Thumbnail unavailable";
    });
  }

  function observeHistoryThumb(img, id) {
    if (typeof IntersectionObserver !== "function") { loadHistoryThumb(img, id); return; }
    if (!historyObserver) {
      historyObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          historyObserver.unobserve(entry.target);
          loadHistoryThumb(entry.target, entry.target.getAttribute("data-history-id"));
        });
      }, { root: itemsEl, rootMargin: "80px 0px" });
    }
    historyObserver.observe(img);
  }

  function renderHistoryRows() {
    clearHistoryThumbs();
    itemsEl.innerHTML = "";
    if (!historyRows.length) {
      itemsEl.innerHTML = '<div class="__ffb_empty">No archived feedback yet.<br>Sent feedback batches appear here.</div>';
      return;
    }
    historyRows.slice(0, historyVisibleCount).forEach(function (row) {
      var item = document.createElement("div"), count = Number(row.count) || 0;
      item.className = "__ffb_item __ffb_hist";
      item.innerHTML = '<img class="__ffb_histthumb" alt="Loading thumbnail" data-history-id="' + esc(String(row.id || "")) + '">' +
        '<div class="__ffb_histbody"><div class="__ffb_histmeta">' + esc(historyTime(row.ts)) + ' · ' + count + ' item' + (count === 1 ? "" : "s") + '</div>' +
        '<div class="__ffb_histpreview">' + esc(String(row.preview || "(no preview)")) + '</div></div>';
      var thumb = item.querySelector(".__ffb_histthumb");
      item.onclick = function () { openHistoryDetail(row.id); };
      itemsEl.appendChild(item);
      observeHistoryThumb(thumb, row.id);
    });
    if (historyRows.length > historyVisibleCount) {
      var more = document.createElement("button");
      more.className = "__ffb_btn";
      more.textContent = "Load more";
      more.onclick = function () { historyVisibleCount += 10; renderHistoryRows(); };
      itemsEl.appendChild(more);
    }
  }

  function openHistoryDetail(id) {
    historyDetailId = id;
    renderList();
  }

  function renderHistoryDetail(id) {
    clearHistoryThumbs();
    itemsEl.innerHTML = '<div class="__ffb_empty">Loading archived feedback…</div>';
    Promise.all([
      historyStore.getMeta(id),
      historyStore.getBlob(id)
    ]).then(function (result) {
      var meta = result[0], blob = result[1], url = URL.createObjectURL(blob);
      if (historyDetailId !== id || activeListTab !== "history" || !panel.classList.contains("open")) { URL.revokeObjectURL(url); return; }
      historyObjectUrls.push(url);
      itemsEl.innerHTML = "";
      var detail = document.createElement("div");
      detail.className = "__ffb_histdetail";
      var back = document.createElement("button");
      back.className = "__ffb_btn";
      back.textContent = "← Back to History";
      back.onclick = function () { historyDetailId = null; renderList(); };
      var shot = document.createElement("div");
      shot.className = "__ffb_histshot";
      var image = document.createElement("img");
      image.src = url;
      image.alt = "Archived feedback screenshot";
      image.onclick = function () { openHistoryLightbox(url, meta); };
      shot.appendChild(image);
      var comments = document.createElement("div");
      (Array.isArray(meta && meta.items) ? meta.items : []).forEach(function (entry) {
        appendHistoryBox(shot, entry);
        var comment = document.createElement("div");
        comment.className = "__ffb_item";
        comment.innerHTML = '<div><span class="__ffb_n">[' + esc(String(entry.n)) + ']</span><span class="__ffb_isel">' + esc(String(entry.sel || "")) + '</span></div>' +
          '<div class="__ffb_cmt">' + (entry.comment ? esc(String(entry.comment)) : '<span style="color:var(--__ffb_mut)">(no comment)</span>') + '</div>';
        comments.appendChild(comment);
      });
      detail.appendChild(back);
      detail.appendChild(shot);
      detail.appendChild(comments);
      itemsEl.appendChild(detail);
    }).catch(function () {
      if (historyDetailId === id && activeListTab === "history" && panel.classList.contains("open")) {
        itemsEl.innerHTML = '<div class="__ffb_empty">Could not load this archived feedback.</div>';
      }
    });
  }

  function renderHistory() {
    clearHistoryThumbs();
    itemsEl.innerHTML = "";
    if (historyDetailId !== null) { renderHistoryDetail(historyDetailId); return; }
    if (typeof window.__FFB_HISTORY_LIST !== "function" && !hasIndexedDb()) {
      itemsEl.innerHTML = '<div class="__ffb_empty">History is available when Fast Feedback is served through the proxy.</div>';
      return;
    }
    if (historyLoading) { itemsEl.innerHTML = '<div class="__ffb_loading"><div class="__ffb_spin"></div>Loading history…</div>'; return; }
    if (historyError) { itemsEl.innerHTML = '<div class="__ffb_empty">Could not load history right now.</div>'; return; }
    if (historyRows) { renderHistoryRows(); return; }
    historyLoading = true;
    itemsEl.innerHTML = '<div class="__ffb_loading"><div class="__ffb_spin"></div>Loading history…</div>';
    historyStore.list().then(function (rows) {
      historyRows = Array.isArray(rows) ? rows.slice().sort(function (a, b) { return (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0); }) : [];
      historyLoading = false;
      if (activeListTab === "history") renderList();
    }).catch(function () {
      historyLoading = false;
      historyError = true;
      if (activeListTab === "history") renderList();
    });
  }

  function setListTab(tab) {
    activeListTab = tab;
    panel.querySelectorAll(".__ffb_tab").forEach(function (button) { button.classList.toggle("sel", button.getAttribute("data-tab") === tab); });
    historyDetailId = null;
    // Reset both cache and error so switching to History always shows the loading
    // spinner and refetches (a prior error must not persist as a stale message).
    if (tab === "history") { historyRows = null; historyError = false; }
    renderList();
  }

  panel.querySelectorAll(".__ffb_tab").forEach(function (button) { button.onclick = function () { setListTab(button.getAttribute("data-tab")); }; });
  function closeList() { historyDetailId = null; clearHistoryThumbs(); panel.classList.remove("open"); }
  panel.querySelector(".__ffb_x").onclick = closeList;
  panel.querySelector("#__ffb_psend").onclick = sendToAI;
  panel.querySelector("#__ffb_pcopy").onclick = copyAll;
  panel.querySelector("#__ffb_pclear").onclick = clearAll;

  // Clear wipes every committed annotation (and its box). Guarded by a confirm
  // since it's destructive and the boxes can't be recovered. Numbering restarts
  // at [1] afterwards so a fresh pass reads cleanly.
  function clearAll() {
    if (!anns.length) return;
    confirmDiscard("Clear all " + anns.length + " feedback item" + (anns.length > 1 ? "s" : "") + "? This can't be undone.", function () {
      anns.forEach(function (a) { if (a.boxEl) a.boxEl.remove(); });
      anns = [];
      counter = 0;
      editingN = null;
      renderList();
    }, "Cancel", "Clear");
  }

  // ---- export / copy ----------------------------------------------------
  function buildExport() {
    var s = "# Fast feedback (" + FILE + ")\n";
    anns.forEach(function (a) {
      var r = a.region;
      s += "- [" + a.n + "] " + a.sel + "  [x" + r.x + "% y" + r.y + "% w" + r.w + "% h" + r.h + "%]  " + (a.comment || "(no comment)") + "\n";
    });
    return anns.length ? s : "(no feedback yet)";
  }
  function copyAll() {
    var text = buildExport();
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(function () { legacyCopy(text); });
    else legacyCopy(text);
    var b = bar.querySelector("#__ffb_copybtn");
    var prev = b.innerHTML; b.textContent = "Copied ✓";
    setTimeout(function () { b.innerHTML = prev; }, 1200);
  }
  function legacyCopy(text) {
    var t = document.createElement("textarea"); t.value = text;
    t.style.position = "fixed"; t.style.opacity = "0"; document.body.appendChild(t);
    t.select(); try { document.execCommand("copy"); } catch (e) {} t.remove();
  }

  // ---- send to AI --------------------------------------------------------
  // Live/proxy mode injects __FFB_SEND. File and console modes archive locally
  // through historyStore, keeping Copy All as the universal fallback.
  var sendInFlight = false;
  function sendToAI() {
    var canSend = typeof window.__FFB_SEND === "function";
    var canArchive = typeof window.__FFB_ARCHIVE === "function" || hasIndexedDb();
    if (!canSend && !canArchive) { showToast("No server — use Copy All", false); return; }
    if (sendInFlight) { showToast("Sending…", false); return; }
    if (!anns.length) { showToast("Nothing new to send", false); return; }
    var snapshot = anns.map(function (a) {
      // Freeze the box geometry (document-absolute, scroll-invariant) at flush
      // start. If the user deletes/clears an annotation while the send is in
      // flight, its boxEl detaches and getBoundingClientRect() would read zeros —
      // archiving the highlight collapsed at top-left. Read it once, up front.
      var r = a.boxEl ? a.boxEl.getBoundingClientRect() : null;
      return {
        ann: a,
        id: a.id,
        revision: a.revision,
        rect: r ? { left: r.left + window.pageXOffset, top: r.top + window.pageYOffset, width: r.width, height: r.height } : null
      };
    });
    var items = snapshot.map(function (entry) {
      var a = entry.ann;
      return { id: entry.id, n: a.n, sel: a.sel, region: a.region, comment: a.comment, url: location.href, ts: new Date().toISOString() };
    });
    var toSend = snapshot.filter(function (entry) { return !entry.ann.sentToInbox; });
    var request;
    var sentToInbox = false;
    var archiveStarted = false;
    sendInFlight = true;
    try {
      request = canSend && toSend.length ? window.__FFB_SEND(toSend.map(function (entry) {
        var a = entry.ann;
        return { id: entry.id, n: a.n, sel: a.sel, region: a.region, comment: a.comment, url: location.href, ts: new Date().toISOString() };
      })) : null;
    } catch (e) {
      sendInFlight = false;
      showToast("Send failed — items kept", true);
      return;
    }
    Promise.resolve(request).then(function () {
      if (canSend && toSend.length) {
        sentToInbox = true;
        // Only mark the revision we actually sent as delivered. If the user edited
        // this annotation while the send was in flight (edit resets sentToInbox to
        // false and bumps revision), leave it unsent so the edited comment is
        // re-delivered to the inbox on the next flush.
        toSend.forEach(function (entry) { if (entry.ann.revision === entry.revision) entry.ann.sentToInbox = true; });
      }
      archiveStarted = true;
      return capturePng(true).then(function (capture) {
        var meta = {
          id: crypto.randomUUID(),
          ts: new Date().toISOString(),
          url: location.href,
          capture: { w: capture.w, h: capture.h },
          items: snapshot.map(function (entry, index) {
            var item = items[index];
            return {
              id: entry.id,
              n: item.n,
              sel: item.sel,
              region: captureRegion(entry.rect, capture),
              comment: item.comment
            };
          })
        };
        return historyStore.archive(meta, capture.blob);
      });
    }).then(function () {
      var flushed = snapshot.filter(function (entry) { return entry.ann.revision === entry.revision && anns.indexOf(entry.ann) !== -1; });
      flushed.forEach(function (entry) { if (entry.ann.boxEl) entry.ann.boxEl.remove(); });
      anns = anns.filter(function (a) { return !flushed.some(function (entry) { return entry.ann === a; }); });
      historyRows = null;
      historyError = false;
      historyVisibleCount = 10;
      renderList();
      showToast((sentToInbox ? "Sent " : "Archived ") + items.length + " items ✓", false);
    }).catch(function () {
      showToast(archiveStarted ? "Archive failed — items kept" : "Send failed — items kept", true);
    }).then(function () {
      sendInFlight = false;
    });
  }

  // ---- screenshot -------------------------------------------------------
  // One-click capture via html2canvas, which the build scripts inline ahead of
  // this engine (window.html2canvas). No browser share-picker, no network — it
  // renders the live DOM to a canvas and copies a PNG straight to the CLIPBOARD
  // so you just Ctrl+V it wherever (e.g. into the chat). We hide our own chrome
  // (bar / panel / form / confirm / draw layer) during the shot so the image
  // shows the APP, but keep the annotation boxes — they're the whole point.
  //
  // The clipboard write is fed a PROMISE (not a ready blob): html2canvas is
  // async, and passing a promise to ClipboardItem lets the browser keep the
  // copy tied to the button's user-gesture while the render finishes. If the
  // clipboard is blocked (permissions / not focused / unsupported, e.g. over
  // file://) we fall back to downloading the PNG so the shot is never lost.
  function capturePng(hideBoxes) {
    var h2c = window.html2canvas;
    if (typeof h2c !== "function") return Promise.reject(new Error("Screenshot needs the bundled html2canvas, which didn't load on this page."));
    var chrome = [bar, panel, form, confirmEl, layer];
    if (hideBoxes) chrome.push(boxwrap);
    var vis = chrome.map(function (n) { return n.style.visibility; });
    chrome.forEach(function (n) { n.style.visibility = "hidden"; });
    var mt = document.body.style.marginTop;      // drop the top strip's spacer
    var bodyTop = document.body.getBoundingClientRect().top;
    document.body.style.marginTop = prevBodyMt;   // so there's no empty band
    var captureShiftY = bodyTop - document.body.getBoundingClientRect().top;
    var restored = false;
    var restore = function () {
      if (restored) return; restored = true;
      chrome.forEach(function (n, i) { n.style.visibility = vis[i]; });
      document.body.style.marginTop = mt;
    };
    try {
      return Promise.resolve(h2c(document.documentElement, { backgroundColor: null, useCORS: true, logging: false, scale: window.devicePixelRatio || 1 }))
        .then(function (canvas) {
          var capture = { w: canvas.width, h: canvas.height, docW: document.documentElement.scrollWidth || 1, docH: document.documentElement.scrollHeight || 1, shiftY: captureShiftY };
          restore();
          return new Promise(function (res, rej) {
            canvas.toBlob(function (blob) { blob ? res({ blob: blob, capture: capture }) : rej(new Error("toBlob returned null")); }, "image/png");
          });
        }).then(function (result) {
          result.capture.blob = result.blob;
          return result.capture;
        }).catch(function (err) { restore(); throw err; });
    } catch (err) {
      restore();
      return Promise.reject(err);
    }
  }

  // rect is the box's document-absolute geometry frozen at flush start
  // (see sendToAI's snapshot). Passing the stored rect — not the live boxEl —
  // keeps replay correct even if the annotation was deleted mid-send.
  function captureRegion(rect, capture) {
    if (!rect) return { x: 0, y: 0, w: 0, h: 0 };
    var scaleX = capture.w / capture.docW, scaleY = capture.h / capture.docH;
    var pct = function (v, total) { return Math.max(0, Math.min(100, Math.round((v / total) * 10000) / 100)); };
    return {
      x: pct(rect.left * scaleX, capture.w),
      y: pct((rect.top - capture.shiftY) * scaleY, capture.h),
      w: pct(rect.width * scaleX, capture.w),
      h: pct(rect.height * scaleY, capture.h)
    };
  }

  function takeScreenshot() {
    if (typeof window.html2canvas !== "function") {
      alert("Screenshot needs the bundled html2canvas, which didn't load on this page.");
      return;
    }
    var b = bar.querySelector("#__ffb_shotbtn"), prev = b.innerHTML;
    b.textContent = "Capturing…";
    var done = function (label) { b.textContent = label; setTimeout(function () { b.innerHTML = prev; }, 1400); };

    // Render → PNG blob. Restore our chrome the moment the canvas is ready.
    var blobPromise = capturePng(false).then(function (capture) { return capture.blob; });

    // Put a copy on disk. Live/proxy mode POSTs the PNG and the server writes it
    // to the configured folder; file/console mode has no server, so it falls back
    // to a normal browser download (Downloads folder).
    function downloadShot(blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = "feedback-screenshot.png"; a.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      return { how: "download" };
    }
    function persistShot(blob) {
      if (shot.save && hasShotServer()) {
        return window.__FFB_SAVE_SHOT(blob)
          .then(function (path) { return { how: "folder", path: path }; })
          .catch(function () { return downloadShot(blob); });
      }
      return Promise.resolve(downloadShot(blob));
    }
    // Clipboard blocked / unsupported → still save the shot so it's never lost.
    function saveOnly() {
      blobPromise.then(persistShot).then(function (res) { done(res && res.how === "folder" ? "Saved to folder ✓" : "Saved ✓"); })
        .catch(function (err) { b.innerHTML = prev; alert("Screenshot failed: " + (err && err.message ? err.message : err)); });
    }

    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      navigator.clipboard.write([new ClipboardItem({ "image/png": blobPromise })])
        .then(function () {
          if (!shot.save) { done("Copied ✓ · Ctrl+V"); return; }   // clipboard only
          blobPromise.then(persistShot).then(function (res) {
            done("Copied ✓ · " + (res && res.how === "folder" ? "Saved" : "Downloaded"));
          });
        })
        .catch(function () { saveOnly(); });   // clipboard blocked → save instead
    } else {
      saveOnly();
    }
  }

  // ---- bar buttons ------------------------------------------------------
  bar.querySelector("#__ffb_toggle").onclick = function () { setActive(!active); };
  bar.querySelector("#__ffb_listbtn").onclick = toggleList;
  bar.querySelector("#__ffb_copybtn").onclick = copyAll;
  bar.querySelector("#__ffb_shotbtn").onclick = takeScreenshot;
  bar.querySelector("#__ffb_setbtn").onclick = openSettings;

  // ---- configurable hotkeys ---------------------------------------------
  // Different machines/OSes have different reflexes and browser-reserved combos,
  // so every shortcut is rebindable (the ⚙ dialog). A binding is Ctrl (or ⌘)
  // plus optional Alt/Shift plus one key, stored by e.code so it's independent
  // of keyboard layout, and persisted in localStorage.
  var DEFAULT_HOTKEYS = {
    toggle:     { ctrl: true, alt: false, shift: false, code: "Period" },
    write:      { ctrl: true, alt: false, shift: false, code: "Slash" },
    list:       { ctrl: true, alt: false, shift: false, code: "BracketLeft" },
    copy:       { ctrl: true, alt: false, shift: false, code: "Quote" },
    send:       { ctrl: true, alt: false, shift: false, code: "Backslash" },
    screenshot: { ctrl: true, alt: false, shift: false, code: "Semicolon" },
    settings:   { ctrl: true, alt: false, shift: false, code: "Comma" }
  };
  var HK_ORDER = [["toggle", "Show / hide"], ["write", "Write (annotate)"], ["list", "List"], ["copy", "Copy all"], ["send", "Send to AI"], ["screenshot", "Screenshot"], ["settings", "Open settings"]];
  function cloneBinding(b) { return { ctrl: !!b.ctrl, alt: !!b.alt, shift: !!b.shift, code: String(b.code) }; }
  function safeLS(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  // Persistence across skill triggers. The build scripts read the on-disk
  // settings file and inject window.__FFB_SETTINGS (hotkeys = global; theme =
  // this project's) + window.__FFB_PROJECT. That injected state is authoritative
  // (it reflects the last saved value); localStorage is the fallback when
  // nothing was injected. On change we write both localStorage AND, if the host
  // provides window.__FFB_SAVE (the proxy does), back to the disk file so the
  // NEXT trigger restores it. Hotkeys are stored globally; theme per project.
  var INJECTED = (window.__FFB_SETTINGS && typeof window.__FFB_SETTINGS === "object") ? window.__FFB_SETTINGS : {};
  var PROJECT = window.__FFB_PROJECT || "default";
  function persist(partial) { if (typeof window.__FFB_SAVE === "function") { try { window.__FFB_SAVE(partial); } catch (e) {} } }

  var hotkeys = (function () {
    var h = {}; for (var k in DEFAULT_HOTKEYS) h[k] = cloneBinding(DEFAULT_HOTKEYS[k]);
    try { var s = safeLS("__ffb_hotkeys"); if (s) { var o = JSON.parse(s); for (var a in h) if (o[a] && o[a].code) h[a] = cloneBinding(o[a]); } } catch (e) {}
    if (INJECTED.hotkeys) { for (var a2 in h) if (INJECTED.hotkeys[a2] && INJECTED.hotkeys[a2].code) h[a2] = cloneBinding(INJECTED.hotkeys[a2]); }
    return h;
  })();
  function saveHotkeys() {
    try { localStorage.setItem("__ffb_hotkeys", JSON.stringify(hotkeys)); } catch (e) {}
    persist({ hotkeys: hotkeys });
  }

  // ---- theme + highlight color (per project) ----------------------------
  // The accent/highlight defaults to gold in dark, bright red in light; the user
  // can override it per mode with the color picker, and Reset drops back to the
  // mode default. Overrides live in `highlight` = { light?, dark? }.
  var DEFAULT_ACCENT = { dark: "#e8b23f", light: "#e5484d" };
  var theme = (INJECTED.theme === "light" || INJECTED.theme === "dark") ? INJECTED.theme : (safeLS("__ffb_theme:" + PROJECT) || "dark");
  var highlight = (function () {
    if (INJECTED.highlight && typeof INJECTED.highlight === "object") return { light: INJECTED.highlight.light || null, dark: INJECTED.highlight.dark || null };
    try { var s = safeLS("__ffb_highlight:" + PROJECT); if (s) { var o = JSON.parse(s); return { light: o.light || null, dark: o.dark || null }; } } catch (e) {}
    return { light: null, dark: null };
  })();

  function hexToRgb(h) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(h || "").trim());
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function readableOn(rgb) {
    // relative luminance → dark ink on light accents, white on dark ones
    var lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    return lum > 0.6 ? "#231a00" : "#ffffff";
  }
  // hex / rgb / hsv conversions for the custom color picker below.
  function rgbToHex(r, g, b) {
    function h(n) { n = Math.max(0, Math.min(255, Math.round(n))); return (n < 16 ? "0" : "") + n.toString(16); }
    return "#" + h(r) + h(g) + h(b);
  }
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
    if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
    return { h: h, s: mx ? d / mx : 0, v: mx };
  }
  function hsvToRgb(h, s, v) {
    var c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c, r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
  }
  function effectiveAccent() { return highlight[theme] || DEFAULT_ACCENT[theme]; }
  // When a custom accent is set, push it (and its derived tokens) as inline vars
  // that beat the theme defaults; when it's the mode default, clear the inline
  // overrides so the CSS theme values apply.
  function applyHighlight() {
    var root = document.documentElement, custom = highlight[theme];
    if (custom) {
      var rgb = hexToRgb(custom);
      if (rgb) {
        root.style.setProperty("--__ffb_gold", custom);
        root.style.setProperty("--__ffb_onaccent", readableOn(rgb));
        root.style.setProperty("--__ffb_hlfill", "rgba(" + rgb.r + "," + rgb.g + "," + rgb.b + ",.14)");
        root.style.setProperty("--__ffb_hlflash", "rgba(" + rgb.r + "," + rgb.g + "," + rgb.b + ",.5)");
        return;
      }
    }
    ["--__ffb_gold", "--__ffb_onaccent", "--__ffb_hlfill", "--__ffb_hlflash"].forEach(function (v) { root.style.removeProperty(v); });
  }
  function saveHighlight() {
    try { localStorage.setItem("__ffb_highlight:" + PROJECT, JSON.stringify(highlight)); } catch (e) {}
    persist({ highlight: highlight, project: PROJECT });
  }

  function applyTheme(t) {
    theme = (t === "light") ? "light" : "dark";
    document.documentElement.classList.toggle("__ffb_light", theme === "light");
    applyHighlight(); // accent default (and any override) is per theme
  }
  function saveTheme() {
    try { localStorage.setItem("__ffb_theme:" + PROJECT, theme); } catch (e) {}
    persist({ theme: theme, project: PROJECT });
  }

  // ---- screenshot save-to-folder (global) -------------------------------
  // Clipboard copy is always on; this adds an optional saved copy. Writing to an
  // exact path needs a server, so it only fully applies in live/proxy mode (which
  // exposes window.__FFB_SAVE_SHOT). In file/console mode there's no server, so a
  // "saved" shot falls back to a normal browser download (Downloads folder) and
  // the folder path can't be honored — the dialog says as much.
  var SHOT_DEFAULT_DIR = INJECTED.screenshotDefaultDir || "";
  var shot = (function () {
    var s = { save: false, dir: "" };
    try { var ls = safeLS("__ffb_shot"); if (ls) { var o = JSON.parse(ls); s.save = !!o.save; s.dir = o.dir || ""; } } catch (e) {}
    if (INJECTED.screenshot && typeof INJECTED.screenshot === "object") { s.save = !!INJECTED.screenshot.save; s.dir = INJECTED.screenshot.dir || ""; }
    return s;
  })();
  function saveShotSettings() {
    try { localStorage.setItem("__ffb_shot", JSON.stringify(shot)); } catch (e) {}
    persist({ screenshot: shot });
  }
  function hasShotServer() { return typeof window.__FFB_SAVE_SHOT === "function"; }

  // ---- custom color picker popover --------------------------------------
  // The browser's native <input type=color> popup can't be restyled or extended,
  // so we roll our own: a saturation/value square, a hue slider, a hex/RGB
  // readout, and a row of presets underneath. It floats over the overlay root
  // (fixed-positioned) so the settings dialog's own scroll never clips it.
  var CPICK_PRESETS = ["#e8b23f", "#e5484d", "#f76808", "#8e4ec6", "#3e63dd", "#30a46c"]; // 6 curated
  var cpick = null;
  var cps = { h: 0, s: 0, v: 0, onPreview: null, onCommit: null, anchor: null };
  function ensureColorPicker() {
    if (cpick) return cpick;
    cpick = document.createElement("div");
    cpick.className = "__ffb_cpick";
    cpick.innerHTML =
      '<div class="__ffb_sv"><div class="__ffb_svwhite"></div><div class="__ffb_svblack"></div><div class="__ffb_svthumb"></div></div>' +
      '<div class="__ffb_hue"><div class="__ffb_huethumb"></div></div>' +
      '<div class="__ffb_cprow"><input class="__ffb_cphex" spellcheck="false" maxlength="7"><div class="__ffb_cprgb"><span class="__ffb_cpr"></span><span class="__ffb_cpg"></span><span class="__ffb_cpb"></span></div></div>' +
      '<div class="__ffb_cppal"></div>';
    root.appendChild(cpick);
    var sv = cpick.querySelector(".__ffb_sv"), svThumb = cpick.querySelector(".__ffb_svthumb");
    var hue = cpick.querySelector(".__ffb_hue"), hueThumb = cpick.querySelector(".__ffb_huethumb");
    var hexIn = cpick.querySelector(".__ffb_cphex"), pal = cpick.querySelector(".__ffb_cppal");
    var rEl = cpick.querySelector(".__ffb_cpr"), gEl = cpick.querySelector(".__ffb_cpg"), bEl = cpick.querySelector(".__ffb_cpb");

    function curHex() { var c = hsvToRgb(cps.h, cps.s, cps.v); return rgbToHex(c.r, c.g, c.b); }
    function syncUI() {
      var rgb = hsvToRgb(cps.h, cps.s, cps.v), hueRgb = hsvToRgb(cps.h, 1, 1);
      sv.style.background = "rgb(" + Math.round(hueRgb.r) + "," + Math.round(hueRgb.g) + "," + Math.round(hueRgb.b) + ")";
      svThumb.style.left = (cps.s * 100) + "%"; svThumb.style.top = ((1 - cps.v) * 100) + "%";
      hueThumb.style.left = (cps.h / 360 * 100) + "%";
      var hx = rgbToHex(rgb.r, rgb.g, rgb.b);
      if (document.activeElement !== hexIn) hexIn.value = hx.toUpperCase();
      rEl.textContent = "R " + Math.round(rgb.r); gEl.textContent = "G " + Math.round(rgb.g); bEl.textContent = "B " + Math.round(rgb.b);
      [].forEach.call(pal.children, function (sw) { sw.classList.toggle("sel", sw.getAttribute("data-c") === hx.toLowerCase()); });
    }
    function preview() { syncUI(); if (cps.onPreview) cps.onPreview(curHex()); }
    function commit() { if (cps.onCommit) cps.onCommit(curHex()); }
    function setFromHex(hex, doCommit) {
      var rgb = hexToRgb(hex); if (!rgb) return;
      var hsv = rgbToHsv(rgb.r, rgb.g, rgb.b); cps.h = hsv.h; cps.s = hsv.s; cps.v = hsv.v;
      preview(); if (doCommit) commit();
    }
    cpick._setFromHex = setFromHex; cpick._syncUI = syncUI;

    CPICK_PRESETS.forEach(function (c) {
      var b = document.createElement("button");
      b.className = "__ffb_sw"; b.style.background = c; b.setAttribute("data-c", c.toLowerCase()); b.title = c;
      b.onmousedown = function (e) { e.preventDefault(); }; // keep hex input from stealing focus/blur
      b.onclick = function () { setFromHex(c, true); };
      pal.appendChild(b);
    });

    function svAt(e) { var r = sv.getBoundingClientRect(); cps.s = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); cps.v = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)); preview(); }
    function hueAt(e) { var r = hue.getBoundingClientRect(); cps.h = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 360; preview(); }
    var dragging = null;
    sv.addEventListener("mousedown", function (e) { e.preventDefault(); dragging = "sv"; svAt(e); });
    hue.addEventListener("mousedown", function (e) { e.preventDefault(); dragging = "hue"; hueAt(e); });
    window.addEventListener("mousemove", function (e) { if (!dragging) return; if (dragging === "sv") svAt(e); else hueAt(e); });
    window.addEventListener("mouseup", function () { if (dragging) { dragging = null; commit(); } });

    function readHex() { var v = hexIn.value.trim(); if (!/^#/.test(v)) v = "#" + v; return /^#[0-9a-fA-F]{6}$/.test(v) ? v : null; }
    hexIn.addEventListener("input", function () { var v = readHex(); if (v) setFromHex(v, false); });
    hexIn.addEventListener("change", function () { var v = readHex(); if (v) setFromHex(v, true); else syncUI(); });
    hexIn.addEventListener("keydown", function (e) { if (e.key === "Enter") hexIn.blur(); e.stopPropagation(); });

    // Click outside the popover (and off its anchor) closes it.
    document.addEventListener("mousedown", function (e) {
      if (!cpick.classList.contains("open")) return;
      if (cpick.contains(e.target) || (cps.anchor && cps.anchor.contains(e.target))) return;
      closeColorPicker();
    }, true);
    return cpick;
  }
  function openColorPicker(anchor, startHex, onPreview, onCommit) {
    ensureColorPicker();
    cps.onPreview = onPreview; cps.onCommit = onCommit; cps.anchor = anchor;
    cpick._setFromHex(startHex, false);
    cpick.classList.add("open");
    var r = anchor.getBoundingClientRect(), w = 216, h = cpick.offsetHeight || 260;
    var left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    var top = (r.bottom + 6 + h > window.innerHeight - 8) ? Math.max(8, r.top - h - 6) : r.bottom + 6;
    cpick.style.left = left + "px"; cpick.style.top = top + "px";
    cpick._syncUI();
  }
  function closeColorPicker() { if (cpick) { cpick.classList.remove("open"); cps.onPreview = cps.onCommit = cps.anchor = null; } }

  var CODE_LABEL = { Period: ".", Slash: "/", BracketLeft: "[", BracketRight: "]", Quote: "'", Semicolon: ";", Comma: ",", Backslash: "\\", Backquote: "`", Minus: "-", Equal: "=", Space: "Space", Enter: "Enter", Tab: "Tab" };
  function keyLabel(code) {
    if (CODE_LABEL[code]) return CODE_LABEL[code];
    var m;
    if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
    if ((m = /^Digit(\d)$/.exec(code))) return m[1];
    if ((m = /^Numpad(\d)$/.exec(code))) return "Num" + m[1];
    if ((m = /^Arrow(\w+)$/.exec(code))) return m[1];
    return code;
  }
  function comboLabel(b) {
    if (!b) return "—";
    var p = []; if (b.ctrl) p.push("Ctrl"); if (b.alt) p.push("Alt"); if (b.shift) p.push("Shift");
    p.push(keyLabel(b.code));
    return p.join("+");
  }
  // Modifier tokens for the tooltip keycap chips, matched to the OS. Shift has a
  // universally-recognized glyph (⇧), so it's an icon everywhere. Ctrl/Alt have
  // no standard Windows symbol, so they're spelled out there; on a Mac the whole
  // set uses the familiar glyphs (⌘ for our "ctrl", since the matcher treats ⌘
  // as ctrl, plus ⌥ ⇧).
  var IS_MAC = /Mac|iPhone|iPad|iPod/i.test((navigator.platform || "") + " " + (navigator.userAgent || ""));
  var MODSYM = IS_MAC ? { ctrl: "⌘", alt: "⌥", shift: "⇧" } : { ctrl: "Ctrl", alt: "Alt", shift: "⇧" };
  function keyTokens(b) {
    var t = []; if (b.ctrl) t.push(MODSYM.ctrl); if (b.alt) t.push(MODSYM.alt); if (b.shift) t.push(MODSYM.shift);
    t.push(keyLabel(b.code));
    return t;
  }
  function labelFor(action) { for (var i = 0; i < HK_ORDER.length; i++) if (HK_ORDER[i][0] === action) return HK_ORDER[i][1]; return action; }
  function sameBinding(a, b) { return a && b && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.code === b.code; }
  function conflictWith(action, b) { for (var k in hotkeys) if (k !== action && sameBinding(hotkeys[k], b)) return k; return null; }
  // Shortcuts live in the custom tooltip, which is built from `hotkeys` on hover,
  // so a rebind is reflected automatically — nothing to pre-render. Kept as a
  // hook the rebind/reset paths call (also dismisses any open tooltip).
  function updateHotkeyHints() { if (typeof hideTip === "function") hideTip(); }

  // ---- settings dialog (centered, non-draggable) ------------------------
  var settingsOpen = false, capturing = null;   // capturing = the action currently listening for a new combo
  var settingsEl = document.createElement("div");
  settingsEl.className = "__ffb_modal";
  settingsEl.innerHTML =
    '<div class="__ffb_setdlg">' +
    '<div class="__ffb_hd2"><span class="__ffb_ttl">Settings</span><button class="__ffb_x" title="Close">✕</button></div>' +
    '<div class="__ffb_srows" id="__ffb_srows"></div>' +
    '<div class="__ffb_snote" id="__ffb_snote"></div>' +
    '<div class="__ffb_setact"><button class="__ffb_btn" id="__ffb_hkreset">Reset to defaults</button><button class="__ffb_btn primary" id="__ffb_hkdone">Done</button></div>' +
    '</div>';
  root.appendChild(settingsEl);
  var srows = settingsEl.querySelector("#__ffb_srows");
  var snote = settingsEl.querySelector("#__ffb_snote");
  var HINT = "Click a shortcut, then press your combo — Ctrl (or ⌘) plus optional Alt / Shift and a key. Esc cancels.";
  function setNote(msg, warn) { snote.textContent = msg; snote.className = "__ffb_snote" + (warn ? " warn" : ""); }
  var SUB = 'color:var(--__ffb_mut);font-weight:400';
  function renderSettings() {
    srows.innerHTML = "";
    // theme (per project)
    var trow = document.createElement("div");
    trow.className = "__ffb_srow";
    trow.innerHTML = '<span class="__ffb_slabel">Theme <span style="' + SUB + '">· this project</span></span>' +
      '<span class="__ffb_seg"><button class="__ffb_segbtn" data-theme="light">Light</button><button class="__ffb_segbtn" data-theme="dark">Dark</button></span>';
    var segLight = trow.querySelector('[data-theme="light"]'), segDark = trow.querySelector('[data-theme="dark"]');
    var paintSeg = function () { segLight.classList.toggle("sel", theme === "light"); segDark.classList.toggle("sel", theme === "dark"); };

    // highlight color (per project, per mode; default = gold in dark, red in light)
    // A hex readout + swatch button + Reset. The swatch opens our custom picker
    // popover (SV square + hue + hex/RGB + presets) — the presets live in there,
    // not in the dialog. Live drags preview() the accent; release commits (saves).
    var hsec = document.createElement("div");
    hsec.className = "__ffb_hlsec";
    hsec.innerHTML =
      '<div class="__ffb_srow"><span class="__ffb_slabel">Highlight color <span style="' + SUB + '">· this project</span></span>' +
      '<span class="__ffb_swatchwrap"><button class="__ffb_reset" id="__ffb_hlreset">Reset</button><span class="__ffb_hex" id="__ffb_hlhex"></span><button class="__ffb_swbtn" id="__ffb_hlpick" title="Pick a color"></button></span></div>';
    var pick = hsec.querySelector("#__ffb_hlpick"), reset = hsec.querySelector("#__ffb_hlreset"), hex = hsec.querySelector("#__ffb_hlhex");
    var refreshHl = function () {
      var eff = effectiveAccent().toLowerCase();
      pick.style.background = eff; hex.textContent = eff.toUpperCase();
      reset.style.visibility = highlight[theme] ? "visible" : "hidden";
    };
    var previewColor = function (c) { highlight[theme] = String(c).toLowerCase(); applyHighlight(); refreshHl(); };
    var commitColor = function (c) { previewColor(c); saveHighlight(); setNote("Highlight color set for " + theme + " mode.", false); };
    pick.onclick = function () {
      if (cpick && cpick.classList.contains("open")) { closeColorPicker(); return; }
      openColorPicker(pick, effectiveAccent(), previewColor, commitColor);
    };
    reset.onclick = function () { highlight[theme] = null; applyHighlight(); saveHighlight(); refreshHl(); closeColorPicker(); setNote("Highlight reset to the " + theme + " default.", false); };

    paintSeg(); refreshHl();
    var onTheme = function (t) { applyTheme(t); saveTheme(); paintSeg(); refreshHl(); closeColorPicker(); setNote("Theme: " + (t === "light" ? "Light" : "Dark") + " — saved for this project.", false); };
    segLight.onclick = function () { onTheme("light"); };
    segDark.onclick = function () { onTheme("dark"); };

    srows.appendChild(trow);
    srows.appendChild(hsec);
    var sep = document.createElement("div"); sep.className = "__ffb_srow_sep"; srows.appendChild(sep);

    // screenshots: save-to-folder (global). Toggle + path. The path only fully
    // applies in live/proxy mode (a server writes it); file/console mode has no
    // server and falls back to a browser download, which the hint spells out.
    var ssec = document.createElement("div");
    ssec.className = "__ffb_hlsec";
    ssec.innerHTML =
      '<div class="__ffb_srow"><span class="__ffb_slabel">Save screenshots to a folder <span style="' + SUB + '">· global</span></span>' +
      '<button class="__ffb_toggle2" id="__ffb_shottgl" role="switch" aria-label="Save screenshots to a folder"><span class="__ffb_knob"></span></button></div>' +
      '<div class="__ffb_srow"><input type="text" class="__ffb_pathin" id="__ffb_shotdir" spellcheck="false"></div>' +
      '<div class="__ffb_shothint" id="__ffb_shothint"></div>';
    var tgl = ssec.querySelector("#__ffb_shottgl"), dirin = ssec.querySelector("#__ffb_shotdir"), shint = ssec.querySelector("#__ffb_shothint");
    dirin.placeholder = SHOT_DEFAULT_DIR || "(default temp folder)";
    dirin.value = shot.dir;
    var paintShot = function () {
      tgl.classList.toggle("on", shot.save);
      tgl.setAttribute("aria-checked", shot.save ? "true" : "false");
      dirin.disabled = !shot.save;
      shint.textContent = !shot.save ? "" :
        (hasShotServer()
          ? "Written to this folder on the machine running the proxy. Leave blank for the default temp folder."
          : "This page has no server, so screenshots download to your browser's Downloads folder — the path above isn't applied here.");
    };
    tgl.onclick = function () { shot.save = !shot.save; saveShotSettings(); paintShot(); setNote(shot.save ? "Screenshots will be saved as well as copied." : "Screenshots copy to clipboard only.", false); };
    dirin.onchange = function () { shot.dir = dirin.value.trim(); saveShotSettings(); };
    dirin.onkeydown = function (e) { if (e.key === "Enter") dirin.blur(); };
    paintShot();
    srows.appendChild(ssec);
    var sep2 = document.createElement("div"); sep2.className = "__ffb_srow_sep"; srows.appendChild(sep2);

    // hotkeys (global)
    HK_ORDER.forEach(function (pair) {
      var action = pair[0];
      var row = document.createElement("div");
      row.className = "__ffb_srow";
      row.innerHTML = '<span class="__ffb_slabel">' + pair[1] + '</span><button class="__ffb_keybtn" data-action="' + action + '">' + comboLabel(hotkeys[action]) + '</button>';
      row.querySelector(".__ffb_keybtn").onclick = function () { startCapture(action, this); };
      srows.appendChild(row);
    });
  }
  function stopCapture() {
    capturing = null;
    var b = srows.querySelector(".__ffb_keybtn.listening");
    if (b) { b.classList.remove("listening"); b.textContent = comboLabel(hotkeys[b.getAttribute("data-action")]); }
  }
  function startCapture(action, btn) {
    stopCapture();
    capturing = action;
    btn.classList.add("listening");
    btn.textContent = "Press keys…";
    setNote("Listening… press Ctrl + optional Alt / Shift + a key. Esc to cancel.", false);
  }
  function openSettings() { settingsOpen = true; renderSettings(); setNote(HINT, false); settingsEl.classList.add("open"); }
  function closeSettings() { stopCapture(); closeColorPicker(); settingsOpen = false; settingsEl.classList.remove("open"); }
  settingsEl.querySelector(".__ffb_x").onclick = closeSettings;
  settingsEl.querySelector("#__ffb_hkdone").onclick = closeSettings;
  settingsEl.querySelector("#__ffb_hkreset").onclick = function () {
    for (var k in DEFAULT_HOTKEYS) hotkeys[k] = cloneBinding(DEFAULT_HOTKEYS[k]);
    saveHotkeys(); updateHotkeyHints(); renderSettings(); setNote("Reset to defaults.", false);
  };
  settingsEl.addEventListener("mousedown", function (e) { if (e.target === settingsEl) closeSettings(); }); // backdrop click closes

  // Capture-phase key listener: while listening for a rebind, swallow the key so
  // it neither triggers the app nor our own shortcuts, then assign the binding.
  window.addEventListener("keydown", function (e) {
    if (!capturing) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.key === "Escape") { setNote("Cancelled.", false); stopCapture(); return; }
    if (e.key === "Control" || e.key === "Alt" || e.key === "Shift" || e.key === "Meta") return; // wait for the main key
    var b = { ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey, code: e.code };
    if (!b.ctrl) { setNote("A shortcut must include Ctrl (or ⌘). Try again.", true); return; }
    var clash = conflictWith(capturing, b);
    if (clash) { setNote("That combo is already used by “" + labelFor(clash) + "”. Try another.", true); return; }
    hotkeys[capturing] = b; saveHotkeys(); updateHotkeyHints();
    var action = capturing; stopCapture();
    setNote("Set " + labelFor(action) + " → " + comboLabel(b) + ".", false);
  }, true);

  // ---- custom tooltip (short text + keycap chips) -----------------------
  // Replaces native title= tooltips (ugly, uncontrollable). Content is built on
  // hover from the LIVE binding, so it always matches the current shortcut.
  var TIP_MAP = {
    __ffb_toggle: { action: "write", desc: "Arm the highlight cursor" },
    __ffb_listbtn: { action: "list", desc: "Open the feedback list" },
    __ffb_copybtn: { action: "copy", desc: "Copy all feedback" },
    __ffb_shotbtn: { action: "screenshot", desc: "Screenshot to clipboard" },
    __ffb_setbtn: { action: "settings", desc: "Settings" }
  };
  var tip = document.createElement("div");
  tip.className = "__ffb_tip";
  root.appendChild(tip);
  var tipTimer = null;
  // Modifier glyphs render better a touch larger (the thin ⇧ looks cramped at the
  // text size), so tag them for the .__ffb_kbdsym bump.
  var MODGLYPHS = "⇧⌘⌥⌃";
  function keycaps(action) {
    return keyTokens(hotkeys[action]).map(function (t) {
      var sym = MODGLYPHS.indexOf(t) !== -1;
      var inner = sym ? '<span class="__ffb_glyph">' + esc(t) + "</span>" : esc(t);
      return '<kbd class="__ffb_kbd' + (sym ? " __ffb_kbdsym" : "") + '">' + inner + "</kbd>";
    }).join("");
  }
  function showTip(target, action, desc) {
    tip.innerHTML = '<span class="__ffb_tiptext">' + esc(desc) + '</span><span class="__ffb_keys">' + keycaps(action) + "</span>";
    tip.classList.add("open");
    var r = target.getBoundingClientRect(), tr = tip.getBoundingClientRect();
    tip.style.left = Math.min(Math.max(6, r.left), window.innerWidth - tr.width - 6) + "px";
    tip.style.top = (r.bottom + 8) + "px";
  }
  function hideTip() { tip.classList.remove("open"); }
  function attachTip(el, action, desc) {
    if (!el) return;
    el.addEventListener("mouseenter", function () { clearTimeout(tipTimer); tipTimer = setTimeout(function () { showTip(el, action, desc); }, 320); });
    el.addEventListener("mouseleave", function () { clearTimeout(tipTimer); hideTip(); });
    el.addEventListener("mousedown", function () { clearTimeout(tipTimer); hideTip(); });
  }
  Object.keys(TIP_MAP).forEach(function (id) { attachTip(bar.querySelector("#" + id), TIP_MAP[id].action, TIP_MAP[id].desc); });
  attachTip(bar.querySelector(".__ffb_tag"), "toggle", "Show / hide the overlay");

  // ---- master enable / disable ------------------------------------------
  // The whole overlay can be hidden with Ctrl+. and brought back the same way,
  // so it stays out of the way when you're just using the app (important when
  // it's always injected — e.g. served through the dev proxy). The choice is
  // remembered in localStorage so a reload keeps it as you left it. Disabling
  // drops the top spacer too, so the page lays out exactly as it normally would.
  var enabled = true;
  try { enabled = localStorage.getItem("__ffb_enabled") !== "0"; } catch (e) {}
  function setEnabled(v) {
    enabled = v;
    try { localStorage.setItem("__ffb_enabled", v ? "1" : "0"); } catch (e) {}
    bar.style.display = v ? "flex" : "none";
    boxwrap.style.display = v ? "" : "none";
    document.body.style.marginTop = v ? (BAR_H + "px") : prevBodyMt;
    if (!v) { closeList(); form.classList.remove("open"); confirmEl.classList.remove("open"); closeSettings(); setActive(false); }
  }

  // ---- hotkeys ----------------------------------------------------------
  // Bindings are configurable (⚙) and matched by modifiers + e.code. Defaults:
  // Ctrl+. show/hide · Ctrl+/ annotate · Ctrl+[ list · Ctrl+' copy · Ctrl+\\ send
  // · Ctrl+; screenshot. Form-local Esc/Ctrl+Enter are handled on the textareas above.
  window.addEventListener("keydown", function (e) {
    if (settingsOpen) { if (e.key === "Escape" && !capturing) { e.preventDefault(); closeSettings(); } return; } // settings owns the keyboard
    if (capturing) return;
    // Esc disarms Write when it's armed and no annotation form is open.
    if (e.key === "Escape" && active && !form.classList.contains("open")) { e.preventDefault(); setActive(false); return; }
    var ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl && !e.altKey && !e.shiftKey) return; // ignore plain keys
    var typing = /^(input|textarea|select)$/i.test((e.target && e.target.tagName) || "") || (e.target && e.target.isContentEditable);
    for (var i = 0; i < HK_ORDER.length; i++) {
      var action = HK_ORDER[i][0], b = hotkeys[action];
      if (ctrl === b.ctrl && e.altKey === b.alt && e.shiftKey === b.shift && e.code === b.code) {
        if (action === "toggle") { e.preventDefault(); setEnabled(!enabled); return; } // master on/off — works even while hidden
        if (!enabled) return;                                                           // every other hotkey is inert while hidden
        if (action === "copy" && typing) return;                                        // don't hijack copy while typing in a field
        e.preventDefault();
        if (action === "write") setActive(!active);
        else if (action === "list") toggleList();
        else if (action === "copy") copyAll();
        else if (action === "send") sendToAI();
        else if (action === "screenshot") takeScreenshot();
        else if (action === "settings") openSettings();
        return;
      }
    }
  });

  // ---- re-show hook (live mode paste-twice) -----------------------------
  window.__ffb_show = function () { setEnabled(true); };
  window.__ffb_teardown = function () {
    document.body.style.marginTop = prevBodyMt;
    clearHistoryThumbs();
    [bar, toast, layer, boxwrap, form, panel, confirmEl, settingsEl, style].forEach(function (n) { if (n && n.remove) n.remove(); });
    window.__ffb_loaded = false;
  };

  applyTheme(theme);    // apply the remembered (per-project) theme on load
  updateHotkeyHints();  // reflect current combos in the button tooltips
  setEnabled(enabled);  // apply the remembered show/hide state on load
  renderList();
})();
