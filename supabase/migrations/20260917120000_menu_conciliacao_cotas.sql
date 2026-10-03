-- Libera a nova tela de Conciliação para quem já tinha Rentabilidade fundos.
insert into public.user_menu_permissions (user_id, menu_key)
select distinct user_id, 'controle-cotas.conciliacao'
from public.user_menu_permissions
where menu_key = 'controle-cotas.rentabilidade'
on conflict (user_id, menu_key) do nothing;
