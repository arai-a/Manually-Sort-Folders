const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

// Logging using the latest from https://developer.mozilla.org/en-US/docs/Mozilla/JavaScript_code_modules/Log.jsm
// Assuming this is 68+ only.
Cu.import("resource://gre/modules/Log.jsm");
let tblog = Log.repository.getLogger("tbsortfolders.ui");
tblog.level = Log.Level.Debug;
tblog.addAppender(new Log.ConsoleAppender(new Log.BasicFormatter()));
tblog.addAppender(new Log.DumpAppender(new Log.BasicFormatter()));

Cu.import("resource://gre/modules/Services.jsm");
const g_ThunderbirdMajorVersion = Services.appinfo.version.split(".")[0];

Cu.import("resource://tbsortfolders/sort.jsm");
Cu.import("resource:///modules/MailUtils.jsm");

if (g_ThunderbirdMajorVersion >= 91) {
  Cu.import("resource:///modules/MailServices.jsm"); // for reorderAccounts
}

try {
  Cu.import("resource:///modules/iteratorUtils.jsm"); // for fixIterator
} catch(e) {
  /* fixIterator was removed together with iteratorutils.jsm on Thunderbird 91.
   * That's no longer needed.
   */
}

var g_accounts = Object();
const tbsf_prefs = Services.prefs.getBranch("extensions.tbsortfolders@xulforum.org.");
var tbsf_data = {};
var current_account = null;

const mail_accountmanager_prefs = Services.prefs.getBranch("mail.accountmanager.");
const mail_account_prefs = Services.prefs.getBranch("mail.account.");
const mail_server_prefs = Services.prefs.getBranch("mail.server.");

/* Most of the functions below are for *folder* sorting */

function assert(v, s) {
  if (!v) {
    tblog.error("Assertion failure "+s);
    throw "Assertion failure";
  }
}

function dump_tree(node, prefix) {
  if (prefix === undefined) prefix = "";
  tblog.debug("Dump tree: "+prefix+node.tagName);
  for (let i = 0; i < node.children.length; i++)
    dump_tree(node.children[i], prefix+" ");
}

function item_key(tree_item) {
  //return tree_item.querySelector("treerow > treecell").getAttribute("value");
  for (let i = 0; i < tree_item.children.length; ++i)
    if (tree_item.children[i].tagName == "treerow")
      return tree_item.children[i].firstChild.getAttribute("value");
  tblog.error("TBSortFolders: severe error, no item key for "+tree_item);
}

function item_label(tree_item) {
  //return tree_item.querySelector("treerow > treecell").getAttribute("label");
  for (let i = 0; i < tree_item.children.length; ++i)
    if (tree_item.children[i].tagName == "treerow")
      return tree_item.children[i].firstChild.getAttribute("label");
  tblog.error("TBSortFolders: severe error, no item label for "+tree_item);
}

let ftvItems = {};

function rebuild_tree(full, collapse) {
  tblog.debug("rebuild_tree("+full+");");
  let dfs = 0;
  /* Cache these expensive calls. They're called for each comparison :( */
  let myFtvItem = function(tree_item) {
    if (!ftvItems[tree_item.id]) {
      let text = item_label(tree_item);
      let folder = MailUtils.getExistingFolder(tree_item.id);
      folder.QueryInterface(Ci.nsIMsgFolder);
      ftvItems[tree_item.id] = { _folder: folder, text: text };
    }
    return ftvItems[tree_item.id];
  }
  let sort_function;
  let replace_data = false;
  let sort_method = tbsf_data[current_account][0];
  if (sort_method == 0) {
      tblog.debug("Sort method 0");
      sort_function = (c1, c2) => tbsf_sort_functions[0](myFtvItem(c1), myFtvItem(c2));
  } else if (sort_method == 1) {
      tblog.debug("Sort method 1");
      sort_function = (c1, c2) => tbsf_sort_functions[1](myFtvItem(c1), myFtvItem(c2));
  } else if (sort_method == 2) {
      tblog.debug("Sort method 2");
      sort_function =
        (c1, c2) => tbsf_sort_functions[2](tbsf_data[current_account][1], myFtvItem(c1), myFtvItem(c2));
      replace_data = true;
  } else if (sort_method == 3) {
      tblog.debug("Sort method 3");
      sort_function = (c1, c2) => tbsf_sort_functions[3](myFtvItem(c1), myFtvItem(c2));
  }
  let fresh_data = {};
  let my_sort = function(a_tree_items, indent) {
    let tree_items = Array();
    //tree_items = a_tree_items;

    tblog.debug(indent+a_tree_items.length+" nodes passed");
    for (let i = 0; i < a_tree_items.length; ++i)
      tree_items.push(a_tree_items[i]);
    tblog.debug(indent+tree_items.length+" folders to examine before sort");
    tree_items.sort(sort_function);

    tblog.debug(indent+tree_items.length+" folders to examine");
    for (let i = 0; i < tree_items.length; ++i) {
      dfs++;
      //let data = tbsf_data[current_account][1];
      /*if (data[item_key(tree_items[i])] !== undefined)
        assert(data[item_key(tree_items[i])] == dfs, "dfs "+dfs+" data "+data[item_key(tree_items[i])]);
      else*/
      /* We need to do this: in case a folder has been deleted in the middle of
      the DFS, the sort keys are not contiguous anymore. However, we wish to
      maintain the invariant that is commented out above (the assert). The
      invariant above (the assert) is broken if a folder has been deleted in the
      meanwhile so we make sure it is enforced with the line below. It only
      changes something in case a folder has been deleted/added since we last
      walked the folder tree.

      It is to be remarked that when a folder has been added, it is sorted
      \emph{at the end} of the list (see special case and comments in
      folderPane.js) so the test above gives true (it's undefined) and we set
      the right sort keys. */
      fresh_data[item_key(tree_items[i])] = dfs;
      if (full) {
        tblog.debug(indent+"### Rebuilding "+dfs+" is "+item_key(tree_items[i]));
      }

      //let n_tree_items = tree_items[i].querySelectorAll("[thisnode] > treechildren > treeitem");
      let n_tree_items = [];
      for (let j = 0; j < tree_items[i].children.length; ++j)
        if (tree_items[i].children[j].tagName == "treechildren")
          n_tree_items = tree_items[i].children[j].children;
      if (n_tree_items.length) {
        my_sort(n_tree_items, indent+" ");
        if (collapse
            && tree_items[i].getAttribute("container") == "true"
            && tree_items[i].getAttribute("open") == "true")
          tree_items[i].setAttribute("open", "false");
      }
    }

    if (full) {
      //dummy, slow insertion algorithm (but only used when the folder list is
      //initially built)
      for (let i = 0; i < tree_items.length; ++i)
        tree_items[i].parentNode.appendChild(tree_items[i].parentNode.removeChild(tree_items[i]));
    } else {
      //cleverer one: we know we're only swapping two items
      let i = 0;
      while (i < tree_items.length && tree_items[0].parentNode.children[i] == tree_items[i])
        i++;
      //we found a difference between what we want and the state of the UI: swap
      //current item with the next
      if (i < tree_items.length - 1) {
        let parent = tree_items[0].parentNode;
        parent.insertBefore(parent.removeChild(parent.children[i+1]), parent.children[i]);
      }
    }
  }

  let children = document.querySelectorAll("#foldersTree > treechildren > treeitem");
  my_sort(children, "");
  if (replace_data)
    tbsf_data[current_account][1] = fresh_data; //this "fresh" array allows us to get rid of old folder's keys
}

function decode_special(flags) {
  if (flags & 0x00000100) {
    return 'Trash';
  } else if (flags & 0x00000200) {
    return 'Sent';
  } else if (flags & 0x00000400) {
    return 'Drafts';
  } else if (flags & 0x00000800) {
    return 'Outbox';
  } else if (flags & 0x00001000) {
    return 'Inbox';
  } else if (flags & 0x00004000) {
    return 'Archives';
  } else if (flags & 0x00400000) {
    return 'Templates';
  } else if (flags & 0x40000000) {
    return 'Junk';
  } else if (flags & 0x80000000) {
    return 'Favorite';
  } else {
    return 'none';
  }
}

function build_folder_tree(account) {
  // Clear folder tree
  let treechildren = document.getElementById("treeChildren");
  while (treechildren.firstChild) {
    treechildren.removeChild(treechildren.firstChild);
  }

  // Fill folder tree
  if (account.incomingServer.rootFolder.hasSubFolders) {
//    tblog.debug("Root Folder keys: "+Object.keys(account.incomingServer.rootFolder));
    walk_folder(account.incomingServer.rootFolder,treechildren,0);
  }
}

function walk_folder(folder,treechildren,depth) {
  let subFolders = folder.subFolders;
  if (Array.isArray(subFolders)) {
    // Thunderbird 91 and later
    subFolders.forEach(s => {
      let folder = s.QueryInterface(Components.interfaces.nsIMsgFolder);
      walk_folder_append(folder,treechildren,depth);
    });
  } else {
    // before Thunderbird 91
    while (typeof subFolders.hasMoreElements === 'function' && subFolders.hasMoreElements()) {
      let folder = subFolders.getNext().QueryInterface(Components.interfaces.nsIMsgFolder);
      walk_folder_append(folder,treechildren,depth);
    }
  }
}

function walk_folder_append(folder,treechildren,depth) {
  let indent = ' '.repeat(2*depth);
  tblog.debug("Folder: "+indent+folder.prettyName);
  tblog.debug("Folder URI: "+indent+folder.URI);
  tblog.debug("Folder flags: "+indent+folder.flags);
    
  let special_name = decode_special(folder.flags);
  tblog.debug("Special name: "+special_name);

  let treeitem = document.createXULElement('treeitem');
  treeitem.setAttribute('id',folder.URI);
  let treerow = document.createXULElement('treerow');
  let treecell = document.createXULElement('treecell');
  treecell.setAttribute('label',folder.prettyName);
  treecell.setAttribute('value',folder.URI);
  treecell.setAttribute('properties','specialFolder-'+special_name);
  treerow.appendChild(treecell);
  treeitem.appendChild(treerow)

  if (folder.hasSubFolders) {

    treeitem.setAttribute('container','true');
    treeitem.setAttribute('open','true');
    let treechildrensub = document.createXULElement('treechildren');
      
    walk_folder(folder,treechildrensub,depth+1);

    treeitem.appendChild(treechildrensub)
  }

  treechildren.appendChild(treeitem);
}


function on_load() {
  try {
    tblog.debug("on_load");

    document.getElementsByTagName('window')[0].maxHeight = screen.availHeight - 32;

    let width = tbsf_prefs.getStringPref("width");
    let height = tbsf_prefs.getStringPref("height");
    if (width < 600) {
      width = 600;
    }
    if (height < 400) {
      height = 400;
    }
    window.resizeTo(width, height);

    let json = tbsf_prefs.getStringPref("tbsf_data");
    try {
      tbsf_data = JSON.parse(json);
    } catch (e) {
    }

    let account_manager = Cc["@mozilla.org/messenger/account-manager;1"].getService(Ci.nsIMsgAccountManager);
    let name_initial = '';
    let name;
    let accounts_menu = document.getElementById("accounts_menu");
    let accounts = [];
    if (Array.isArray(account_manager.accounts)) {
      accounts = account_manager.accounts;
    } else {
      if (typeof fixIterator === 'function') {
        for (let x of fixIterator(account_manager.accounts, Ci.nsIMsgAccount)) {
          accounts.push(x);
        }
      }
    }
    tblog.debug("Total accounts: "+accounts.length);
    if (!accounts.length) {
      document.querySelector("tabbox").style.display = "none";
      document.getElementById("err_no_accounts").style.display = "";
      return;
    }
    for (let account of accounts) {
      //    tblog.debug("Account keys: "+Object.keys(account));
      //fill the menulist with the right elements
      if (!account.incomingServer)
        continue;
      tblog.debug("Account: "+account.incomingServer.rootFolder.prettyName);
      let name = account.incomingServer.rootFolder.prettyName;
      let it = document.createXULElement("menuitem");
      it.setAttribute("label", name);
      accounts_menu.appendChild(it);

      //register the account for future use, create the right data structure in
      //the data
      g_accounts[name] = account;
      if (!tbsf_data[name]) tbsf_data[name] = Array();
      if (!name_initial) name_initial = name;
    }
    document.getElementById("accounts_menu").parentNode.setAttribute("label", name_initial);


    tblog.debug("Accounts: "+account_manager.accounts.length);
    //  tblog.debug("Account Manager keys: "+Object.keys(account_manager));
    // try {
    //   let tb_accounts = mail_accountmanager_prefs.getStringPref("accounts");
    //   let tbsf_accounts = tbsf_prefs.getStringPref("accounts");

    //   tblog.debug("TB Accounts: "+tb_accounts);
    //   tblog.debug("TBSF Accounts: "+tbsf_accounts);

    //   let tb_default_account = mail_accountmanager_prefs.getStringPref("defaultaccount");
    //   let tbsf_default_account = tbsf_prefs.getStringPref("defaultaccount");

    //   tblog.debug("TB Default account: "+tb_default_account);
    //   tblog.debug("TBSF Default account: "+tbsf_default_account);
    // } catch (x) {
    // }


    on_account_changed();

    accounts_on_load();
    extra_on_load();
  } catch (e) {
    tblog.debug(e);
    throw e;
  }
}

function renumber(treeItem, start) {
  tbsf_data[current_account][1][item_key(treeItem)] = start++;
  let children = []; // = treeItem.querySelectorAll("treechildren > treeitem"); but only starting from the root
  for (let j = 0; j < treeItem.children.length; ++j)
    if (treeItem.children[j].tagName == "treechildren")
      children = treeItem.children[j].children;

  for (let i = 0; i < children.length; ++i)
    start = renumber(children[i], start);
  return start;
}

function move_up(tree_item) {
  let tree = document.getElementById("foldersTree");
  let uri = item_key(tree_item);
  tblog.debug("URI: "+uri);
  if (tree_item.previousSibling) {
    let previous_item = tree_item.previousSibling;
    let previous_uri = item_key(previous_item);
    let data = tbsf_data[current_account][1];
    renumber(previous_item, renumber(tree_item, data[previous_uri]));
    rebuild_tree();
    //tree.builder.rebuild();
  } else {
    tblog.debug("This is unexpected");
  }
  /*for (let i = 0; i < 10; ++i) {
    let tree_item = tree.view.getItemAtIndex(i);
    let k = item_key(tree_item);
    tblog.debug(tbsf_data[current_account][1][k]+" ");
  } tblog.debug("");*/
}

function on_move_up() {
  tblog.debug("on_move_up");
  const tree = document.getElementById("foldersTree");
  if (tree.currentIndex < 0) return;
  const tree_item = tree.view.getItemAtIndex(tree.currentIndex);
  if (tree_item.previousSibling) {
    move_up(tree_item);
    tree.view.selection.select(tree.view.getIndexOfItem(tree_item));
  }
}

function on_move_down() {
  tblog.debug("on_move_down");
  const tree = document.getElementById("foldersTree");
  if (tree.currentIndex < 0) return;
  const tree_item = tree.view.getItemAtIndex(tree.currentIndex);
  if (tree_item.nextSibling) {
    move_up(tree_item.nextSibling);
    tree.view.selection.select(tree.view.getIndexOfItem(tree_item));
  }
}

function on_alphabetical() {
  tblog.debug("on_alphabetical");
  const tree = document.getElementById("foldersTree");
  if (tree.currentIndex < 0) return;
  const tree_item = tree.view.getItemAtIndex(tree.currentIndex);
  const uri = item_key(tree_item);
  const parent = tree_item.parentNode;
  if (!parent) return;
  const compare_function = document.getElementById("sort_folder_name_case_sensitive").checked ?
        ((a, b) => a > b) : ((a, b) => a.toLowerCase() > b.toLowerCase());
  let number = tbsf_data[current_account][1][item_key(parent.firstChild)];
  let siblingArray = [];
  for (let i = 0; i < parent.children.length; i++) {
    siblingArray.push(parent.children[i]);
  }
  siblingArray.sort((a, b) => compare_function(item_label(a), item_label(b)));
  siblingArray.forEach(item => {
    parent.appendChild(item);
    number = renumber(item, number);
  });
  rebuild_tree(true, false);
  tree.view.selection.select(tree.view.getIndexOfItem(tree_item));
}

function get_sort_method_for_account(account) {
  if (tbsf_data[account] && tbsf_data[account][0] !== undefined)
    return tbsf_data[account][0];
  else
    return 0;
}

function update_tree() {
  let account = g_accounts[current_account];
  let root_folder = account.incomingServer.rootFolder; // nsIMsgFolder
  let tree = document.getElementById("foldersTree");
  tree.setAttribute("ref", root_folder.URI);

  build_folder_tree(account);
}

function on_account_changed() {
  //update the UI
  let new_account = document.getElementById("accounts_menu").parentNode.getAttribute("label");
  if (new_account != current_account) {
    current_account = new_account;
    let sort_method = get_sort_method_for_account(current_account);
    document.getElementById("sort_method").value = sort_method;
    update_tree();
    on_sort_method_changed();
  }
}

function on_sort_method_changed() {
  let sort_method = document.getElementById("sort_method").getAttribute("value");
  tbsf_data[current_account][0] = sort_method;
  if (sort_method == 2) {
    document.getElementById("default_sort_box").style.display = "none";
    document.getElementById("alphabetical_sort_box").style.display = "none";
    document.getElementById("manual_sort_box").style.display = "";
    if (!tbsf_data[current_account][1])
      tbsf_data[current_account][1] = {};
  } else if (sort_method == 1 || sort_method == 3) {
    document.getElementById("default_sort_box").style.display = "none";
    document.getElementById("alphabetical_sort_box").style.display = "";
    document.getElementById("manual_sort_box").style.display = "none";
  } else if (sort_method == 0) {
    document.getElementById("default_sort_box").style.display = "";
    document.getElementById("alphabetical_sort_box").style.display = "none";
    document.getElementById("manual_sort_box").style.display = "none";
  }
  tbsf_prefs.setStringPref("tbsf_data", JSON.stringify(tbsf_data));
  rebuild_tree(true, true);
}

function on_close() {
  on_refresh();
  window.close();
}

function on_refresh() {
  tbsf_prefs.setStringPref("tbsf_data", JSON.stringify(tbsf_data));
  for (let win of Services.wm.getEnumerator("mail:3pane")) {
    win.gFolderTreeView._rebuild();
  }
  tbsf_prefs.setStringPref("width", window.outerWidth);
  tbsf_prefs.setStringPref("height", window.outerHeight);
}

window.addEventListener("unload", on_refresh, false);


/* The functions below are for *account* sorting */

var g_other_accounts = [];
var g_active_list = null;

function accounts_on_load() {
  let accounts = mail_accountmanager_prefs.getStringPref("accounts").split(",");
  let defaultaccount = mail_accountmanager_prefs.getStringPref("defaultaccount");
  if (g_ThunderbirdMajorVersion < 91) {
    accounts = accounts.filter((x) => x != defaultaccount);
    accounts = [defaultaccount].concat(accounts);
  }
  accounts = accounts.filter((a) => mail_account_prefs.getPrefType(a+".server") === mail_account_prefs.PREF_STRING); // Avoid error occurs in following getStringPref .
  let servers = accounts.map((a) => mail_account_prefs.getStringPref(a+".server"));
  let types = servers.map((s) => mail_server_prefs.getStringPref(s+".type"));
  let names = servers.map(function (s) {
    try {
      return mail_server_prefs.getStringPref(s+".name");
    } catch (e) {
      return mail_server_prefs.getStringPref(s+".hostname");
    } });

  let mail_accounts = [];
  let news_accounts = [];
  let other_accounts = [];
  let add_li = function (list, [account, server, type, name]) {
    let li = document.createXULElement("richlistitem");
    let desc = document.createXULElement("description");
    let txt = document.createTextNode(name); 
    desc.appendChild(txt);
    li.appendChild(desc);
    li.value = account;
    list.appendChild(li);
  };
  let news_account_found = false;
  if (g_ThunderbirdMajorVersion < 91) {
    /* Because of Thunderbird bug 244347, we had to treat regular accounts 
     * (email and RSS), news accounts, and others (local folders fall into 
     * this category) differently.
     */
    for (let i = 0; i < accounts.length; ++i) {
      switch (types[i]) {
      case "imap":
      case "pop3":
      case "exquilla":
      case "movemail":
      case "rss":
        mail_accounts.unshift([accounts[i], servers[i], types[i], names[i]]);
        add_li(document.getElementById("accounts_list"), mail_accounts[0]);
        document.getElementById("default_account").firstChild.setAttribute("disabled", false);
        /* We're not setting the "first account in the list" value in the UI
         * because it defaults to "first rss or mail account in the list */
        break;
      case "nntp":
        news_account_found = true;
        news_accounts.unshift([accounts[i], servers[i], types[i], names[i]]);
        let mi = document.createXULElement("menuitem");
        mi.setAttribute("value", accounts[i]);
        mi.setAttribute("label", names[i]);
        document.getElementById("default_account").appendChild(mi);
        add_li(document.getElementById("news_accounts_list"), news_accounts[0]);
        /* Set the "first account in the list value in the UI */
        if (defaultaccount == accounts[i])
          mi.parentNode.parentNode.value = accounts[i];
        break;
      default:
        let hidden = false;
        try {
          let hidden_pref = mail_server_prefs.getStringPref(servers[i]+".hidden");
          hidden = hidden_pref;
        } catch (e) {
        }
        if (!hidden) {
          let mi = document.createXULElement("menuitem");
          mi.setAttribute("value", accounts[i]);
          mi.setAttribute("label", names[i]);
          document.getElementById("default_account").appendChild(mi);
          /* Set the "first account in the list" value in the UI */
          if (defaultaccount == accounts[i])
            mi.parentNode.parentNode.value = accounts[i];
        }
        other_accounts.unshift([accounts[i], servers[i], types[i], names[i]]);
      }
    }
    g_other_accounts = other_accounts;
    if (news_account_found) {
      document.getElementById("news_accounts_list").style.display = "";
    }
  } else {
    /* Since Thunderbird 91, all accounts are treated equally. */
    let accounts_list = document.getElementById("accounts_list");
    for (let i = 0; i < accounts.length; ++i) {
      mail_accounts.unshift([accounts[i], servers[i], types[i], names[i]]);
      add_li(accounts_list, mail_accounts[0]);
    }
  }
  g_active_list = document.getElementById("accounts_list");

  /* Avoid Thunderbird bug(?) */
  if (g_active_list.selectedIndex < 0 && g_active_list.getItemAtIndex(0)) {
    g_active_list.selectedIndex = 0;
  }

  /* Don't understand why this was needed here. */
  //update_accounts_prefs();
}

function update_accounts_prefs() {
  let accounts = document.getElementById("accounts_list");
  let new_pref = null;
  let first_mail_account = null;
  for (let i = 0; i < accounts.children.length; ++i) {
    let child = accounts.children[i];
    if (!first_mail_account)
      first_mail_account = child.value;
    new_pref = new_pref ? (new_pref + "," + child.value) : child.value;
  }
  for (let i = 0; i < g_other_accounts.length; ++i) {
    let [account, server, type, name] = g_other_accounts[i];
    new_pref = new_pref ? (new_pref + "," + account) : account;
  }
  if (g_ThunderbirdMajorVersion < 91) {
    let news_accounts = document.getElementById("news_accounts_list");
    for (let i = 0; i < news_accounts.children.length; ++i) {
      let child = news_accounts.children[i];
      new_pref = new_pref ? (new_pref + "," + child.value) : child.value;
    }
  }

  mail_accountmanager_prefs.setStringPref("accounts",new_pref);
  //tbsf_prefs.setStringPref("accounts",new_pref);
  tblog.debug("Sorted accounts: "+new_pref);
  
  if (g_ThunderbirdMajorVersion < 91) {
    let default_account = document.getElementById("default_account").parentNode.value;
    if (default_account == "-1") {
      mail_accountmanager_prefs.setStringPref("defaultaccount",first_mail_account);
      tbsf_prefs.setStringPref("defaultaccount",first_mail_account);
      tblog.debug("Default account: "+first_mail_account);
    } else {
      mail_accountmanager_prefs.setStringPref("defaultaccount",default_account);
      tbsf_prefs.setStringPref("defaultaccount",default_account);
      tblog.debug("Default account: "+default_account);
    }
  }
}

function account_reordered() {

  if (g_ThunderbirdMajorVersion < 91) {
    return; // The following operations are impossible before Thunderbird 91. Therefore, the only way to reflect the account reordering we have done in prefs is to restart Thunderbird.
  }

  // Send reordered account list to MailServices.
  let accountIds = [];
  for (let account of document.getElementById("accounts_list").children) {
    accountIds.push(account.value);
  }
  MailServices.accounts.reorderAccounts(accountIds);

  // Notify the UI to rebuild the account tree.
  for (let win of Services.wm.getEnumerator("mail:3pane")) {
    win.gFolderTreeView._rebuild();
    let tabmail = win.document.getElementById("tabmail");
    for (let tabInfo of tabmail.tabInfo) {
      let tab = tabmail.getTabForBrowser(tabInfo.browser);
      if (tab && tab.urlbar && tab.urlbar.value == "about:accountsettings") {
        tab.browser.reload();
        return;
      }
    }
  }
}

function account_move_up(index, listbox) {
  let item = listbox.getItemAtIndex(index);
  if (!item)
    return false;

  let previous_item = item.previousSibling;
  if (!previous_item)
    return false;

  let parent = item.parentNode;
  parent.insertBefore(parent.removeChild(item), previous_item);

  return true;
}

function on_account_move_up() {
  tblog.debug("on_account_move_up");
  if (!g_active_list) return;

  let listbox = g_active_list;
  let i = listbox.selectedIndex;
  
  tblog.debug("index: "+i);
  
  if (i < 0) return;
  if (account_move_up(i, listbox))
    listbox.selectedIndex = i-1;
  update_accounts_prefs();
  account_reordered();
}

function on_account_move_down() {
  tblog.debug("on_account_move_down");
  if (!g_active_list) return;

  let listbox = g_active_list;
  let i = listbox.selectedIndex;
  
  tblog.debug("index: "+i);

  if (i < 0) return;
  if (account_move_up(i+1, listbox))
    listbox.selectedIndex = i+1;
  update_accounts_prefs();
  account_reordered();
}

function on_account_alphabetical() {
  tblog.debug("on_account_alphabetical");
  if (!g_active_list) return;

  let tmpAry = new Array();
  for (let i = 0; i < g_active_list.children.length; i++) {
    tmpAry[i] = new Array();
    tmpAry[i][0] = g_active_list.children[i].textContent;
    tmpAry[i][1] = g_active_list.children[i].value;
  }
  if (document.getElementById("sort_account_name_case_sensitive").checked) {
    tmpAry.sort();
  } else {
    tmpAry.sort((a, b) => a[0].toLowerCase() > b[0].toLowerCase());
  }
  while (g_active_list.children.length > 0) {
    g_active_list.children[0].remove();
  }
  for (let i = 0; i < tmpAry.length; i++) {
    let li = document.createXULElement("richlistitem");
    let desc = document.createXULElement("description");
    let txt = document.createTextNode(tmpAry[i][0]); 
    desc.appendChild(txt);
    li.appendChild(desc);
    li.value = tmpAry[i][1];
    g_active_list.appendChild(li);
  }
  g_active_list.selectedIndex = 0;
  update_accounts_prefs();
  account_reordered();
}

function on_account_restart() {
  let mainWindow = Services.wm.getMostRecentWindow("mail:3pane");
  mainWindow.setTimeout(function () { Services.startup.quit(Services.startup.eForceQuit|Services.startup.eRestart); },1000);
  window.close();
}

function on_accounts_list_click() {
  if (g_ThunderbirdMajorVersion < 91) {
    g_active_list = document.getElementById("accounts_list");
    document.getElementById("news_accounts_list").clearSelection();
  }
}

function on_news_accounts_list_click() {
  if (g_ThunderbirdMajorVersion < 91) {
    g_active_list = document.getElementById("news_accounts_list");
    document.getElementById("accounts_list").clearSelection();
  }
}

/* These are UI functions for the "Extra settings" tab */

/* Borrowed from http://mxr.mozilla.org/comm-central/source/mailnews/base/prefs/content/am-copies.js */
function on_pick_folder(aEvent) {
  let folder = aEvent.target._folder;
  let picker = document.getElementById("startupFolder");
  picker.folder = folder;
  picker.setAttribute("label", folder.prettyName+'  ('+folder.URI+')');
  tbsf_prefs.setStringPref("startup_folder", folder.URI);
}

function extra_on_load() {
  let startup_folder = tbsf_prefs.getStringPref("startup_folder");
  let picker = document.getElementById("startupFolder");
  let folder;
  if (startup_folder)
    folder = MailUtils.getExistingFolder(startup_folder);
  if (folder) {
    picker.folder = folder;
    picker.setAttribute("label", folder.prettyName+'  ('+folder.URI+')');
  } else {
    let menu = document.getElementById("startup_folder_method");
    menu.value = "0";
    picker.disabled = true;
    picker.style.display = "none";
  }
  on_startup_folder_method_changed();

  document.getElementById("hideFolderIcons").checked = Boolean(tbsf_prefs.getStringPref("hide_folder_icons"));
}

function on_startup_folder_method_changed() {
  const method = document.getElementById("startup_folder_method").getAttribute("value");
  const picker = document.getElementById("startupFolder");
  let notice = false;
  if (method == "1") {
    picker.style.display = "";
    picker.disabled = false;
    if (picker.folder)
      tbsf_prefs.setStringPref("startup_folder", picker.folder.URI);
    notice = (g_ThunderbirdMajorVersion < 98);
  } else {
    picker.style.display = "none";
    picker.disabled = true;
    tbsf_prefs.setStringPref("startup_folder", "");
  }
  document.getElementById("startup_folder_notice").style.display = notice ? "" : "none";

}

function on_hide_folder_icons_changed() {
  tbsf_prefs.setStringPref("hide_folder_icons", document.getElementById("hideFolderIcons").checked ? "True" : "");
}
