-- Run from setup.sh, not during normal editor startup.
local errors = {}
local notify = vim.notify
vim.notify = function(message, level, options)
  if level and level >= vim.log.levels.ERROR then
    errors[#errors + 1] = tostring(message)
  end
  return notify(message, level, options)
end

local ok, err = xpcall(function()
  local config = vim.fn.stdpath("config")
  -- -u NONE and -l disable plugins; lazy.nvim checks this option.
  vim.go.loadplugins = true
  vim.g.rcs_bootstrap = true
  vim.opt.rtp:prepend(config)
  dofile(config .. "/init.lua")

  local function check_plugins()
    -- Lazy schedules caught init/config errors instead of throwing them.
    local drained = false
    vim.schedule(function()
      drained = true
    end)
    assert(vim.wait(1000, function()
      return drained
    end), "Startup diagnostics did not finish")
    assert(#errors == 0, table.concat(errors, "\n"))
    assert(not vim.g.rcs_bootstrap_errors, vim.g.rcs_bootstrap_errors)
    local lazy_config = require("lazy.core.config")
    for _, diagnostic in ipairs(lazy_config.spec.notifs) do
      assert(diagnostic.level < vim.log.levels.ERROR, diagnostic.msg)
    end
    local plugins = lazy_config.plugins
    assert(plugins.LazyVim and plugins.LazyVim._.installed, "LazyVim was not installed")
    for name, plugin in pairs(plugins) do
      for _, task in ipairs(plugin._.tasks or {}) do
        assert(not task:has_errors(), name .. ": " .. (task:output() or "plugin task failed"))
      end
    end
  end

  -- Startup installs missing plugins. Check it before restore replaces task state.
  check_plugins()
  require("lazy").restore({ wait = true, show = false })
  check_plugins()
  -- Restoring an imported spec can introduce dependencies absent from the drifted version.
  for _ = 1, 10 do
    local installed = require("lazy.core.loader").install_missing()
    check_plugins()
    if not installed then
      break
    end
  end
  for name, plugin in pairs(require("lazy.core.config").plugins) do
    assert(plugin._.installed, name .. " was not installed")
  end
end, debug.traceback)

if not ok then
  io.stderr:write("LazyVim setup failed: " .. tostring(err) .. "\n")
  vim.cmd("cquit 1")
end
vim.cmd("qa!")
